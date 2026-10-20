package api

import (
	"math/rand/v2"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// mixedRevisions returns count revisions with seqs 1..count whose paths
// alternate between MaxPathBytes and one byte, so a page that cannot fit a
// long one could still fit the short one after it.
func mixedRevisions(count int) []store.Revision {
	random := rand.NewChaCha8([32]byte{200})
	createdAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	revisions := make([]store.Revision, count)
	for index := range revisions {
		length := 1
		if index%2 == 0 {
			length = MaxPathBytes
		}

		path := randomBytes(random, length)
		for position := range path {
			path[position] = 'a' + path[position]%26
		}

		revisions[index] = store.Revision{
			ID:         uuid.New(),
			DocumentID: uuid.New(),
			VaultID:    uuid.New(),
			Seq:        int64(index + 1),
			Kind:       "markdown",
			ContentRef: randomBytes(random, 32),
			Path:       string(path),
			DeviceID:   uuid.New(),
			UserID:     uuid.New(),
			CreatedAt:  createdAt,
		}
	}

	return revisions
}

var pageCodecHeaders = map[string]http.Header{
	"binary": {"Content-Type": []string{"application/proto"}},
	"JSON":   {"Content-Type": []string{"application/json"}},
}

// Issue #200: with revisions of mixed sizes, a ListChanges page that cannot
// fit the next revision ends there, even if a later, smaller one would fit:
// paging from each page's last seq returns every revision exactly once, in
// order.
func TestChangesPagesOfMixedSizesStayInOrder(t *testing.T) {
	revisions := mixedRevisions(200)

	for name, header := range pageCodecHeaders {
		t.Run(name, func(t *testing.T) {
			var (
				got   []int64
				pages int
				since int64
			)

			for range len(revisions) + 1 {
				// The store returns the revisions after the cursor.
				remaining := revisions[since:]
				limit := min(len(remaining), MaxChangesPageSize)

				response := changesPage(header, MinResponseLimitBytes, store.Changes{
					Revisions: remaining[:limit], HasMore: limit < len(remaining), HeadSeq: int64(len(revisions)),
				})
				require.NotEmpty(t, response.GetRevisions(), "page after seq %d makes no progress", since)

				pages++

				for _, revision := range response.GetRevisions() {
					got = append(got, int64(revision.GetSeq()))
				}

				since = got[len(got)-1]

				if !response.GetHasMore() {
					break
				}
			}

			want := make([]int64, len(revisions))
			for index, revision := range revisions {
				want[index] = revision.Seq
			}

			assert.Equal(t, want, got)
			assert.Greater(t, pages, 1, "the budget never cut a page")
		})
	}
}

// Issue #200: the same for GetDocumentHistory, which pages newest first by
// page token.
func TestHistoryPagesOfMixedSizesStayInOrder(t *testing.T) {
	ascending := mixedRevisions(200)

	newestFirst := make([]store.Revision, len(ascending))
	for index, revision := range ascending {
		newestFirst[len(ascending)-1-index] = revision
	}

	document := store.Document{ID: uuid.New(), VaultID: uuid.New(), Kind: "markdown", HeadRevID: newestFirst[0].ID}

	for name, header := range pageCodecHeaders {
		t.Run(name, func(t *testing.T) {
			var (
				got   []int64
				pages int
				token string
			)

			for range len(newestFirst) + 1 {
				before, err := decodeHistoryToken(token)
				require.NoError(t, err)

				// The store returns the revisions with seq < before.
				remaining := newestFirst
				if before > 0 {
					remaining = newestFirst[len(newestFirst)-int(before)+1:]
				}

				limit := min(len(remaining), MaxHistoryPageSize)

				response := historyPage(header, MinResponseLimitBytes, store.History{
					Document: document, Revisions: remaining[:limit], HasMore: limit < len(remaining),
				})
				require.NotEmpty(t, response.GetRevisions(), "page before seq %d makes no progress", before)

				pages++

				for _, revision := range response.GetRevisions() {
					got = append(got, int64(revision.GetSeq()))
				}

				token = response.GetNextPageToken()
				if token == "" {
					break
				}
			}

			want := make([]int64, len(newestFirst))
			for index, revision := range newestFirst {
				want[index] = revision.Seq
			}

			assert.Equal(t, want, got)
			assert.Greater(t, pages, 1, "the budget never cut a page")
		})
	}
}
