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
	Name       string          `json:"name"`
	Seed       int64           `json:"seed"`
	Clients    int             `json:"clients"`
	Engines    int             `json:"engines,omitempty"`
	Violations []violation     `json:"violations"`
	Steps      json.RawMessage `json:"steps"`
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

	mu      sync.Mutex
	users   int
	reports []regressionCase
}

func (control *control) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", control.token)
	mux.HandleFunc("POST /check", control.check)
	mux.HandleFunc("POST /report", control.report)

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

	token, err := control.sign(control.issuer.Claims(subject, time.Now()))
	if err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)

		return
	}

	respond(writer, map[string]string{"token": token})
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

	violations, err := checkInvariants(request.Context(), control.db, vaultID, body.Acknowledged)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)

		return
	}

	respond(writer, map[string]any{"violations": violations})
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
