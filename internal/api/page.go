package api

import (
	"net/http"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// MinResponseLimitBytes is the smallest send limit the server may run with:
// a ListChanges or GetDocumentHistory response carrying one revision, with
// a MaxPathBytes path and every other field at its largest, and a
// ListVaults response carrying one vault, with a MaxVaultNameBytes name,
// fit it in either encoding (binary protobuf or JSON), compressed or not.
// Every page holds at least one entry, so a smaller limit could make a page
// that cannot be sent and a client that can never advance its cursor. The
// configuration rejects smaller limits at startup.
const MinResponseLimitBytes = 16 << 10

// pageReserveBytes is kept free in every page for what an entry's own
// encoded size does not count: the response's other fields, JSON
// separators and gzip framing.
const pageReserveBytes = 1 << 10

// pageBudget fills a page of entries (revisions or vaults) up to a byte
// budget below the response limit, measuring each entry as the request's
// codec encodes it. The first entry is always admitted, so every page makes
// progress; MinResponseLimitBytes guarantees that one entry fits the limit.
type pageBudget struct {
	// remaining is the budget left; unbounded when limited is false.
	remaining int
	limited   bool
	json      bool
	admitted  int
}

// newPageBudget returns the budget of a response to a request, for a
// response limit of limitBytes (zero: unbounded).
func newPageBudget(header http.Header, limitBytes int) *pageBudget {
	if limitBytes <= 0 {
		return &pageBudget{}
	}

	// gzip (compress/flate) adds 5 bytes per 16 KiB block of
	// incompressible input; a thousandth of the limit covers it with room
	// to spare.
	return &pageBudget{
		remaining: limitBytes - limitBytes/1000 - pageReserveBytes,
		limited:   true,
		json:      isJSONContentType(header.Get("Content-Type")),
	}
}

// isJSONContentType reports whether a Connect, gRPC or gRPC-Web request
// uses the JSON codec ("application/json", "application/grpc+json", ...).
func isJSONContentType(contentType string) bool {
	mediaType, _, _ := strings.Cut(strings.ToLower(contentType), ";")

	return strings.HasSuffix(strings.TrimSpace(mediaType), "json")
}

// admit reports whether entry, a repeated message field of the response,
// fits the page, and charges it to the budget if so.
func (budget *pageBudget) admit(entry proto.Message) bool {
	if !budget.limited {
		return true
	}

	size := budget.entryBytes(entry)
	if budget.admitted > 0 && size > budget.remaining {
		return false
	}

	budget.remaining -= size
	budget.admitted++

	return true
}

func (budget *pageBudget) entryBytes(entry proto.Message) int {
	if budget.json {
		encoded, err := (protojson.MarshalOptions{}).Marshal(entry)
		if err != nil {
			// Unreachable for the messages served here; count the
			// entry as filling the page.
			return budget.remaining + 1
		}

		// A separating comma, possibly followed by a space.
		return len(encoded) + 2
	}

	// The field's tag (one byte for field numbers below 16) and length
	// prefix.
	return 1 + protowire.SizeBytes(proto.Size(entry))
}
