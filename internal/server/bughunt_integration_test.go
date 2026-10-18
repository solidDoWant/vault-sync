//go:build integration

package server_test

import (
	"testing"

	"connectrpc.com/connect"

	"github.com/solidDoWant/vault-sync/internal/api"
)

// Bughunt probe: the server accepts a live file whose path is a folder of
// another live file, a state no filesystem can materialize.
func TestBughuntFileFolderCollision(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	tests := []struct{ name, first, second string }{
		{name: "file then child", first: "notes", second: "notes/c.md"},
		{name: "child then file", first: "x/y/z.md", second: "x/y"},
		{name: "case-folded file then child", first: "Folder", second: "folder/c.md"},
		{name: "case-folded child then file", first: "STRASSE/a.md", second: "straße"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			alice.mustCommit(t, alice.create(t, test.first, content))
			_, err := alice.commit(t, alice.create(t, test.second, content))
			requireCode(t, connect.CodeAlreadyExists, err)
		})
	}
}
