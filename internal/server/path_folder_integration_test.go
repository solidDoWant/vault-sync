//go:build integration

package server_test

import (
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
)

// requireAlreadyExists is a require.ErrorAssertionFunc for ALREADY_EXISTS.
func requireAlreadyExists(t require.TestingT, err error, msgAndArgs ...any) {
	if helper, ok := t.(interface{ Helper() }); ok {
		helper.Helper()
	}

	require.Error(t, err, msgAndArgs...)
	require.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err), append(msgAndArgs, err.Error())...)
}

// Issue #134: a live document cannot sit at, or under, the folder another
// live document's path names, compared by path_key (SPEC.md §5, §6.3). On
// every platform a file and a folder cannot share a name.
func TestCommitRefusesFileFolderCollisions(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")

	tests := []struct {
		name string
		// deleted are created and then deleted, in order, before live.
		deleted []string
		// live are created, in order, and stay live.
		live []string
		// The action: create a document at create; or rename the
		// document at renameFrom to renameTo (as a tombstone if
		// renameDeletes); or resurrect the tombstoned document at
		// resurrect. NFC and NFD forms are spelled out in the
		// names, since the literals look alike.
		create               string
		renameFrom, renameTo string
		renameDeletes        bool
		resurrect            string
		assertion            require.ErrorAssertionFunc
	}{
		// The reproducer from the issue.
		{name: "file then child", live: []string{"notes"}, create: "notes/c.md", assertion: requireAlreadyExists},
		{name: "child then file", live: []string{"x/y/z.md"}, create: "x/y", assertion: requireAlreadyExists},
		{name: "case-folded file then child", live: []string{"Folder"}, create: "folder/c.md", assertion: requireAlreadyExists},
		{name: "case-folded child then file", live: []string{"STRASSE/a.md"}, create: "straße", assertion: requireAlreadyExists},

		{name: "file then deep descendant", live: []string{"notes"}, create: "notes/a/b/c.md", assertion: requireAlreadyExists},
		{name: "deep descendant then top-level file", live: []string{"x/y/z.md"}, create: "x", assertion: requireAlreadyExists},
		{name: "full case folding, ß under SS", live: []string{"straße"}, create: "STRASSE/a.md", assertion: requireAlreadyExists},
		{name: "NFC file then NFD child", live: []string{"café"}, create: "café/a.md", assertion: requireAlreadyExists},
		{name: "NFD child then NFC file", live: []string{"café/a.md"}, create: "CAFÉ", assertion: requireAlreadyExists},
		{name: "file then child of a folder below it", live: []string{"a/b"}, create: "a/b/c/d.md", assertion: requireAlreadyExists},

		{name: "rename under a live file", live: []string{"notes", "other.md"}, renameFrom: "other.md", renameTo: "Notes/c.md", assertion: requireAlreadyExists},
		{name: "rename onto a live document's folder", live: []string{"notes/c.md", "other.md"}, renameFrom: "other.md", renameTo: "NOTES", assertion: requireAlreadyExists},
		{name: "rename a file under its own old path", live: []string{"notes"}, renameFrom: "notes", renameTo: "notes/c.md"},
		{name: "rename a document onto its own old folder", live: []string{"notes/c.md"}, renameFrom: "notes/c.md", renameTo: "notes"},
		{name: "a delete that moves under a live file", live: []string{"notes", "other.md"}, renameFrom: "other.md", renameTo: "notes/c.md", renameDeletes: true},

		{name: "tombstoned file does not collide with a child", deleted: []string{"notes"}, create: "notes/c.md"},
		{name: "tombstoned child does not collide with a file", deleted: []string{"notes/c.md"}, create: "Notes"},
		{name: "resurrecting a file over a live child", deleted: []string{"notes"}, live: []string{"notes/c.md"}, resurrect: "notes", assertion: requireAlreadyExists},
		{name: "resurrecting a child under a live file", deleted: []string{"notes/c.md"}, live: []string{"notes"}, resurrect: "notes/c.md", assertion: requireAlreadyExists},
		{name: "resurrecting with no collision", deleted: []string{"notes/c.md"}, live: []string{"notes/d.md"}, resurrect: "notes/c.md"},

		{name: "siblings in one folder", live: []string{"notes/c.md"}, create: "notes/d.md"},
		{name: "a name that only starts like the file", live: []string{"notes"}, create: "notes.md/c.md"},
		{name: "a folder that only starts like the file", live: []string{"a/b"}, create: "a/bc/d.md"},
		{name: "a file that only starts like the folder", live: []string{"a/bc/d.md"}, create: "a/b"},
		{name: "same name in another folder", live: []string{"x/notes"}, create: "notes/c.md"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := alice.in(fixture.createVault(t, alice.token, "Notes").GetId())
			content := client.content(t, "content")
			heads := map[string]*vaultsyncv1.Revision{}

			for _, path := range test.deleted {
				created := client.mustCommit(t, client.create(t, path, content))
				heads[path] = client.mustCommit(t, client.next(t, created, path, content, true))
			}

			for _, path := range test.live {
				heads[path] = client.mustCommit(t, client.create(t, path, content))
			}

			var request *vaultsyncv1.CommitRevisionRequest

			switch {
			case test.create != "":
				request = client.create(t, test.create, content)
			case test.renameFrom != "":
				request = client.next(t, heads[test.renameFrom], test.renameTo, content, test.renameDeletes)
			default:
				request = client.next(t, heads[test.resurrect], test.resurrect, content, false)
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
				assert.Equal(t, int(before), fixture.count(t, "revisions", client.vaultID), "no revision is written")
			} else {
				assert.Equal(t, before+1, fixture.headSeq(t, client.vaultID))
			}
		})
	}
}

// Issue #134: of a file and a document under the folder it names, committed
// concurrently on different replicas, exactly one is committed. Commits to a
// vault are serialized by its row lock, which the check runs under.
func TestConcurrentFileFolderCollisionCommitsOneSide(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")

	pairs := []struct{ name, file, child string }{
		{name: "same case", file: "notes", child: "notes/c.md"},
		{name: "case-folded", file: "Folder", child: "folder/sub/c.md"},
		{name: "full case folding", file: "straße", child: "STRASSE/a.md"},
	}

	const rounds = 10

	for _, pair := range pairs {
		t.Run(pair.name, func(t *testing.T) {
			for round := range rounds {
				client := alice.in(fixture.createVault(t, alice.token, "Notes").GetId())
				content := client.content(t, "content")

				requests := []*vaultsyncv1.CommitRevisionRequest{
					client.create(t, pair.file, content),
					client.create(t, pair.child, content),
				}
				// Alternate which side goes to which replica.
				if round%2 == 1 {
					requests[0], requests[1] = requests[1], requests[0]
				}

				errs := make([]error, len(requests))

				var (
					wait  sync.WaitGroup
					start = make(chan struct{})
				)

				for index, request := range requests {
					wait.Go(func() {
						<-start

						_, errs[index] = client.commitOn(t, index, request)
					})
				}

				close(start)
				wait.Wait()

				var committed, refused int

				for _, err := range errs {
					if err == nil {
						committed++

						continue
					}

					requireAlreadyExists(t, err)

					refused++
				}

				require.Equal(t, 1, committed, "round %d: exactly one side is committed", round)
				require.Equal(t, 1, refused, "round %d", round)
				require.Equal(t, uint64(1), fixture.headSeq(t, client.vaultID), "round %d", round)
			}
		})
	}
}
