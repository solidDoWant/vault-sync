//go:build sim

package sim_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
)

// maxControlBody bounds request bodies to the control endpoint. A
// regression case or an acknowledgement list of even a very long run stays
// far below it.
const maxControlBody = 64 << 20

// regressionCase is a minimized failing schedule (sim/control.ts
// RegressionCase). Steps are kept verbatim.
type regressionCase struct {
	Name    string `json:"name"`
	Seed    int64  `json:"seed"`
	Clients int    `json:"clients"`
	Engines int    `json:"engines,omitempty"`
	// CommitRetryBackoff is absent in cases recorded before #110.
	CommitRetryBackoff *int `json:"commitRetryBackoff,omitempty"`
	// FaithfulFilesystem is set when the run used the faithful filesystem
	// (SIM_FAITHFUL_FS=1); the regressions suite replays the case with it.
	FaithfulFilesystem bool            `json:"faithfulFilesystem,omitempty"`
	Violations         []violation     `json:"violations"`
	Steps              json.RawMessage `json:"steps"`
}

var regressionName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,99}$`)

// control is the driver's loopback endpoint for the harness (sim/control.ts):
// it mints tokens, checks invariants in PostgreSQL and records failing
// seeds. It is part of the test, never of the server.
type control struct {
	db            *pgxpool.Pool
	issuer        *authtest.Issuer
	key           authtest.Key
	regressionDir string
	// tokenExpiry is when every token the endpoint mints expires
	// (tokenExpiry).
	tokenExpiry time.Time

	mu      sync.Mutex
	users   int
	reports []regressionCase
	// purged lists, per vault, the revisions runs had retention purge.
	purged map[uuid.UUID][]purgedRevision
	// snapshots holds, per vault, the backup the next restore restores.
	snapshots map[uuid.UUID]vaultSnapshot
}

func (control *control) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", control.token)
	mux.HandleFunc("POST /check", control.check)
	mux.HandleFunc("POST /report", control.report)
	mux.HandleFunc("POST /purge", control.purge)
	mux.HandleFunc("POST /prune-markers", control.pruneMarkers)
	mux.HandleFunc("POST /snapshot", control.snapshot)
	mux.HandleFunc("POST /restore", control.restore)
	mux.HandleFunc("POST /age-uploads", control.ageUploads)

	return http.MaxBytesHandler(mux, maxControlBody)
}

// recorded returns the regression cases reported so far.
func (control *control) recorded() []regressionCase {
	control.mu.Lock()
	defer control.mu.Unlock()

	return append([]regressionCase(nil), control.reports...)
}

// token mints an access token for a user no earlier run used, so that runs
// never approach the per-user vault and device limits.
func (control *control) token(writer http.ResponseWriter, _ *http.Request) {
	control.mu.Lock()
	control.users++
	subject := fmt.Sprintf("sim-user-%d", control.users)
	control.mu.Unlock()

	claims := control.issuer.Claims(subject, time.Now())
	claims["exp"] = control.tokenExpiry.Unix()

	token, err := control.sign(claims)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)

		return
	}

	respond(writer, map[string]string{"token": token})
}

const (
	// tokenExpiryMargin keeps tokens valid a little past the test deadline,
	// for clock skew between the driver and the server.
	tokenExpiryMargin = time.Minute
	// unboundedTokenLifetime is the token lifetime of a run without a
	// deadline (`go test -timeout 0`).
	unboundedTokenLifetime = 7 * 24 * time.Hour
)

// tokenExpiry returns when the tokens of a run expire: after the `go test`
// deadline (SIM_TIMEOUT) if it has one, so that no run, however many steps a
// seed has, outlives its token and fails with UNAUTHENTICATED (#110). A run
// mints one token and uses it for every call.
func tokenExpiry(deadline time.Time, hasDeadline bool, now time.Time) time.Time {
	if !hasDeadline {
		return now.Add(unboundedTokenLifetime)
	}

	return deadline.Add(tokenExpiryMargin)
}

func (control *control) sign(claims map[string]any) (string, error) {
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: control.key.Algorithm, Key: jose.JSONWebKey{Key: control.key.Private, KeyID: control.key.ID}},
		(&jose.SignerOptions{}).WithType("JWT"),
	)
	if err != nil {
		return "", err
	}

	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}

	signed, err := signer.Sign(payload)
	if err != nil {
		return "", err
	}

	return signed.CompactSerialize()
}

func (control *control) check(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		VaultID      string            `json:"vaultId"`
		Acknowledged []acknowledgement `json:"acknowledged"`
		Heads        []clientHeads     `json:"heads"`
	}

	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)

		return
	}

	vaultID, err := uuid.Parse(body.VaultID)
	if err != nil {
		http.Error(writer, "vaultId: "+err.Error(), http.StatusBadRequest)

		return
	}

	control.mu.Lock()
	purged := append([]purgedRevision(nil), control.purged[vaultID]...)
	control.mu.Unlock()

	violations, err := checkInvariants(request.Context(), control.db, vaultID, body.Acknowledged, purged, body.Heads)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)

		return
	}

	respond(writer, map[string]any{"violations": violations})
}

// purge ages revisions past the retention policy and purges them with the
// server's own retention code (ageAndPurge), as if the run had lasted that
// long, and remembers what it purged for the invariant checks. It returns the
// purged revision ids.
func (control *control) purge(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		VaultID     string   `json:"vaultId"`
		RevisionIDs []string `json:"revisionIds"`
	}

	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)

		return
	}

	vaultID, err := uuid.Parse(body.VaultID)
	if err != nil {
		http.Error(writer, "vaultId: "+err.Error(), http.StatusBadRequest)

		return
	}

	revisionIDs := make([]uuid.UUID, 0, len(body.RevisionIDs))

	for _, id := range body.RevisionIDs {
		revisionID, err := uuid.Parse(id)
		if err != nil {
			http.Error(writer, "revisionIds: "+err.Error(), http.StatusBadRequest)

			return
		}

		revisionIDs = append(revisionIDs, revisionID)
	}

	purged, err := ageAndPurge(request.Context(), control.db, vaultID, revisionIDs)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)

		return
	}

	control.mu.Lock()
	if control.purged == nil {
		control.purged = map[uuid.UUID][]purgedRevision{}
	}

	// Every purged revision is returned, so the harness reports a purged
	// head (retention-head), but only the others are excused.
	control.purged[vaultID] = append(control.purged[vaultID], excusable(purged)...)
	control.mu.Unlock()

	ids := make([]string, len(purged))
	for index, revision := range purged {
		ids[index] = revision.ID.String()
	}

	respond(writer, map[string][]string{"purged": ids})
}

// pruneMarkers ages every purge marker of a vault past the default marker
// horizon and prunes them with the server's own retention code
// (PruneMarkers), as the retention job would once that much time had passed
// since the purges (SPEC.md §11, #514). It returns how many it pruned.
func (control *control) pruneMarkers(writer http.ResponseWriter, request *http.Request) {
	vaultID, err := vaultIDFromBody(request)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)

		return
	}

	pruned, err := ageAndPruneMarkers(request.Context(), control.db, vaultID)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)

		return
	}

	respond(writer, map[string]int{"pruned": pruned})
}

// report writes a minimized failing schedule to the regression directory,
// as <name>.json, ready to be committed.
func (control *control) report(writer http.ResponseWriter, request *http.Request) {
	var regression regressionCase
	if err := json.NewDecoder(request.Body).Decode(&regression); err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)

		return
	}

	if !regressionName.MatchString(regression.Name) {
		http.Error(writer, "name must match "+regressionName.String(), http.StatusBadRequest)

		return
	}

	encoded, err := json.MarshalIndent(regression, "", "  ")
	if err == nil {
		err = os.MkdirAll(control.regressionDir, 0o755)
	}

	path := filepath.Join(control.regressionDir, regression.Name+".json")
	if err == nil {
		err = os.WriteFile(path, append(encoded, '\n'), 0o644)
	}

	if err != nil {
		http.Error(writer, errors.Join(errors.New("write regression case"), err).Error(), http.StatusInternalServerError)

		return
	}

	control.mu.Lock()
	control.reports = append(control.reports, regression)
	control.mu.Unlock()

	respond(writer, map[string]string{"path": path})
}

func respond(writer http.ResponseWriter, value any) {
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(value)
}
