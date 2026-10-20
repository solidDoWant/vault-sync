package api

import (
	"bytes"
	"compress/gzip"
	"math"
	"math/rand/v2"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// A page of revisions is cut so that the whole response, not just its
// revisions, fits the send limit: the response's other fields and JSON
// separators included, compressed or not. For each page length the test
// finds the tightest limit for it (the smallest at which a page holds that
// many revisions) and checks the response fits it in every encoding the
// server sends.
func TestPagesOfRevisionsFitTheSendLimitInEveryEncoding(t *testing.T) {
	createdAt := time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
	random := rand.NewChaCha8([32]byte{123})

	// Random paths of the largest length; as protobuf bytes a path's size
	// only depends on its length.
	revisions := make([]store.Revision, MaxChangesPageSize+1)
	for index := range revisions {
		revisions[index] = store.Revision{
			ID:          uuid.New(),
			DocumentID:  uuid.New(),
			VaultID:     uuid.New(),
			Seq:         1<<62 + int64(index),
			ParentRevID: uuid.NullUUID{UUID: uuid.New(), Valid: true},
			Kind:        "markdown",
			ContentRef:  randomBytes(random, 32),
			ContentSize: 1 << 62,
			Path:        string(randomBytes(random, MaxPathBytes)),
			Deleted:     true,
			DeviceID:    uuid.New(),
			UserID:      uuid.New(),
			CreatedAt:   createdAt,
		}
	}

	document := store.Document{ID: uuid.New(), VaultID: uuid.New(), Kind: "markdown", HeadRevID: revisions[0].ID, CreatedAt: createdAt}

	// Every revision from its own device, with the name JSON expands most,
	// so each one also brings a device name into the page.
	deviceNames := make(map[uuid.UUID]string, len(revisions))
	for _, revision := range revisions {
		deviceNames[revision.DeviceID] = strings.Repeat(`"`, MaxDeviceNameBytes)
	}

	responses := []struct {
		name string
		page func(header http.Header, limit int) (proto.Message, int)
		// named is whether each entry also brings a device name.
		named bool
	}{
		{
			name: "ListChangesResponse",
			page: func(header http.Header, limit int) (proto.Message, int) {
				response := changesPage(header, limit, store.Changes{Revisions: revisions, HasMore: true, HeadSeq: math.MaxInt64})

				return response, len(response.GetRevisions())
			},
		},
		{
			name: "GetDocumentHistoryResponse",
			page: func(header http.Header, limit int) (proto.Message, int) {
				response := historyPage(header, limit, store.History{Document: document, Revisions: revisions, HasMore: true, DeviceNames: deviceNames})

				return response, len(response.GetRevisions())
			},
			named: true,
		},
	}

	encodings := []struct {
		name        string
		contentType string
		marshal     func(proto.Message) ([]byte, error)
	}{
		{name: "binary", contentType: "application/proto", marshal: proto.Marshal},
		{name: "JSON", contentType: "application/json", marshal: protojson.Marshal},
	}

	for _, encoding := range encodings {
		header := http.Header{"Content-Type": []string{encoding.contentType}}

		one, err := encoding.marshal(revisionMessage(revisions[0]))
		require.NoError(t, err)

		name, err := encoding.marshal(&vaultsyncv1.DeviceName{DeviceId: revisions[0].DeviceID.String(), Name: deviceNames[revisions[0].DeviceID]})
		require.NoError(t, err)

		for _, response := range responses {
			t.Run(encoding.name+"/"+response.name, func(t *testing.T) {
				entryBytes := len(one)
				if response.named {
					entryBytes += len(name)
				}

				for _, length := range []int{1, 2, 3, 4, 5, 16, 100, 240, MaxChangesPageSize} {
					limit := tightestLimit(t, length, entryBytes, func(limit int) int {
						_, got := response.page(header, limit)

						return got
					})

					message, _ := response.page(header, limit)
					encoded, err := encoding.marshal(message)
					require.NoError(t, err)

					assert.LessOrEqual(t, len(encoded), limit, "%d revisions", length)
					assert.LessOrEqual(t, len(gzipped(t, encoded)), limit, "%d revisions, gzip", length)
				}
			})
		}
	}
}

// gzip makes incompressible content larger, by about 5 bytes per 16 KiB.
// A revision's ids compress, so a page of real revisions does not grow; a
// page of entries that are wholly random bytes does, and over a page of a
// few MiB the growth exceeds a fixed reserve. Such a page still fits the
// limit once gzipped.
func TestPagesOfIncompressibleEntriesFitTheSendLimitGzipped(t *testing.T) {
	random := rand.NewChaCha8([32]byte{231})

	entries := make([]*vaultsyncv1.Revision, MaxChangesPageSize+1)
	for index := range entries {
		entries[index] = &vaultsyncv1.Revision{Path: randomBytes(random, MaxPathBytes)}
	}

	header := http.Header{"Content-Type": []string{"application/proto"}}
	page := func(limit int) *vaultsyncv1.ListChangesResponse {
		budget := newPageBudget(header, limit)
		response := &vaultsyncv1.ListChangesResponse{HasMore: true, HeadSeq: math.MaxUint64}

		for _, entry := range entries {
			if !budget.admit(entry) {
				break
			}

			response.Revisions = append(response.Revisions, entry)
		}

		return response
	}

	entryBytes := len(marshalBinary(t, &vaultsyncv1.ListChangesResponse{Revisions: entries[:1]}))

	for _, length := range []int{1, 4, 16, 100, 240, MaxChangesPageSize} {
		limit := tightestLimit(t, length, entryBytes, func(limit int) int {
			return len(page(limit).GetRevisions())
		})

		encoded := marshalBinary(t, page(limit))

		assert.LessOrEqual(t, len(encoded), limit, "%d entries", length)
		assert.LessOrEqual(t, len(gzipped(t, encoded)), limit, "%d entries, gzip", length)
	}
}

// tightestLimit returns the smallest allowed send limit at which a page
// holds length entries of about entryBytes each, given the page length
// pageLength returns at a limit; pages only grow with the limit. The
// search starts below the entries' own size and ends well above it; a
// limit outside that range fails the length check.
func tightestLimit(t *testing.T, length, entryBytes int, pageLength func(limit int) int) int {
	t.Helper()

	lower := max(MinResponseLimitBytes, (length-1)*entryBytes)
	window := MinResponseLimitBytes + 2*entryBytes + length*entryBytes/100
	limit := lower + sort.Search(window, func(extra int) bool {
		return pageLength(lower+extra) >= length
	})

	// The smallest allowed limit may already hold more.
	if limit > MinResponseLimitBytes {
		require.Equal(t, length, pageLength(limit), "page at the tightest limit for %d entries", length)
	}

	return limit
}

func randomBytes(random *rand.ChaCha8, length int) []byte {
	data := make([]byte, length)
	_, _ = random.Read(data)

	return data
}

func marshalBinary(t *testing.T, message proto.Message) []byte {
	t.Helper()

	data, err := proto.Marshal(message)
	require.NoError(t, err)

	return data
}

func gzipped(t *testing.T, data []byte) []byte {
	t.Helper()

	var buffer bytes.Buffer

	writer := gzip.NewWriter(&buffer)
	_, err := writer.Write(data)
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	return buffer.Bytes()
}
