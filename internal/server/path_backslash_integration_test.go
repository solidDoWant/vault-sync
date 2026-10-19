//go:build integration

package server_test

import (
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/pathkey"
)

// requireInvalidArgument is a require.ErrorAssertionFunc for
// INVALID_ARGUMENT.
func requireInvalidArgument(t require.TestingT, err error, msgAndArgs ...any) {
	if helper, ok := t.(interface{ Helper() }); ok {
		helper.Helper()
	}

	require.Error(t, err, msgAndArgs...)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), append(msgAndArgs, err.Error())...)
}

// seedLegacyPath gives a live document, committed through the API, the path
// legacy instead, as a commit accepted before the backslash rule (#191)
// would have left it: its head revision's path and its path_key.
func (fixture *syncFixture) seedLegacyPath(t *testing.T, head *vaultsyncv1.Revision, legacy string) *vaultsyncv1.Revision {
	t.Helper()

	_, err := fixture.pool.Exec(t.Context(), `UPDATE revisions SET path = $2 WHERE id = $1`, head.GetId(), legacy)
	require.NoError(t, err)

	_, err = fixture.pool.Exec(t.Context(), `UPDATE documents SET path_key = $2 WHERE id = $1`, head.GetDocumentId(), pathkey.Key(legacy))
	require.NoError(t, err)

	seeded, ok := proto.Clone(head).(*vaultsyncv1.Revision)
	require.True(t, ok)

	seeded.Path = []byte(legacy)

	return seeded
}

// Issue #191: "\" is a separator on Windows only, so a commit may never
// create or rename a document into a path containing one (SPEC.md §6.2).
// Otherwise a/b and a\b, or a file notes and a document notes\c.md, could
// both be live though they name one file on Windows.
func TestCommitRefusesNewBackslashPaths(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")

	tests := []struct {
		name string
		// live are created, in order, and stay live.
		live []string
		// The action: create a document at create, or rename the
		// document at renameFrom to renameTo.
		create               string
		renameFrom, renameTo string
		assertion            require.ErrorAssertionFunc
	}{
		// The reproducers from the issue.
		{name: "a backslash twin of a live path", live: []string{"a/b"}, create: `a\b`, assertion: requireInvalidArgument},
		{name: "a backslash child of a live file", live: []string{"notes"}, create: `notes\c.md`, assertion: requireInvalidArgument},

		{name: "a backslash path in an empty vault", create: `a\b`, assertion: requireInvalidArgument},
		{name: "a backslash inside a name", create: `notes/a\b.md`, assertion: requireInvalidArgument},
		{name: "a rename into a backslash path", live: []string{"a.md"}, renameFrom: "a.md", renameTo: `x\a.md`, assertion: requireInvalidArgument},
		{name: "the slash path is still accepted", create: "a/b"},
		{name: "the slash child of a live file is a folder collision", live: []string{"notes"}, create: "notes/c.md", assertion: requireAlreadyExists},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := alice.in(fixture.createVault(t, alice.token, "Notes").GetId())
			content := client.content(t, "content")
			heads := map[string]*vaultsyncv1.Revision{}

			for _, path := range test.live {
				heads[path] = client.mustCommit(t, client.create(t, path, content))
			}

			request := client.create(t, test.create, content)
			if test.renameFrom != "" {
				request = client.next(t, heads[test.renameFrom], test.renameTo, content, false)
			}

			before := fixture.headSeq(t, client.vaultID)
			_, err := client.commit(t, request)

			assertion := test.assertion
			if assertion == nil {
				assertion = require.NoError
			}

			assertion(t, err)

			if err != nil {
				assert.Equal(t, before, fixture.headSeq(t, client.vaultID), "nothing is committed")
				assert.Equal(t, len(test.live), fixture.count(t, "documents", client.vaultID), "no document is written")
			}
		})
	}

	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`, "refused paths are not internal errors")
}

// Issue #191 (decision on #52): a document committed with a "\" path before
// the rule existed stays usable, so no acknowledged write is stuck (SPEC.md
// §2, principle 1): it can be edited and deleted in place and renamed to a
// valid path. Only moving it to a "\" path, or bringing it back to its "\"
// path once deleted, counts as creating one and is refused.
func TestExistingBackslashDocumentStaysEditable(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")

	const legacy = `notes\old.md`

	tests := []struct {
		name string
		// deleteFirst tombstones the document at its legacy path
		// before the action.
		deleteFirst bool
		// The action, on top of the document's head.
		path      string
		deleted   bool
		assertion require.ErrorAssertionFunc
	}{
		{name: "edit in place", path: legacy},
		{name: "delete in place", path: legacy, deleted: true},
		{name: "rename to a valid path", path: "notes/old.md"},
		{name: "delete moving to a valid path", path: "notes/old.md", deleted: true},
		{name: "rename to another backslash path", path: `notes\new.md`, assertion: requireInvalidArgument},
		{name: "rename to a backslash path differing only in case", path: `Notes\old.md`, assertion: requireInvalidArgument},
		{name: "delete moving to another backslash path", path: `notes\new.md`, deleted: true, assertion: requireInvalidArgument},
		{name: "resurrect at the backslash path", deleteFirst: true, path: legacy, assertion: requireInvalidArgument},
		{name: "resurrect at a valid path", deleteFirst: true, path: "notes/old.md"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := alice.in(fixture.createVault(t, alice.token, "Notes").GetId())
			content := client.content(t, "content")
			edited := client.content(t, "edited")

			head := fixture.seedLegacyPath(t, client.mustCommit(t, client.create(t, "placeholder.md", content)), legacy)
			if test.deleteFirst {
				head = client.mustCommit(t, client.next(t, head, legacy, content, true))
			}

			before := fixture.headSeq(t, client.vaultID)
			committed, err := client.commit(t, client.next(t, head, test.path, edited, test.deleted))

			assertion := test.assertion
			if assertion == nil {
				assertion = require.NoError
			}

			assertion(t, err)

			if err != nil {
				assert.Equal(t, before, fixture.headSeq(t, client.vaultID), "nothing is committed")

				return
			}

			assert.Equal(t, before+1, fixture.headSeq(t, client.vaultID))
			assert.Equal(t, test.path, string(committed.GetPath()))
			fixture.requireDocumentMirrorsHead(t, committed.GetDocumentId(), committed)
		})
	}
}

// Issue #191: a document committed with a "\" path before the rule stays
// readable: the change feed still serves it as it was stored.
func TestExistingBackslashDocumentStaysReadable(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	client := alice.in(fixture.createVault(t, alice.token, "Notes").GetId())
	content := client.content(t, "content")

	fixture.seedLegacyPath(t, client.mustCommit(t, client.create(t, "placeholder.md", content)), `a\b`)

	changes := client.allChanges(t, 0, 0)
	require.Len(t, changes, 1)
	assert.Equal(t, `a\b`, string(changes[0].GetPath()))
}
