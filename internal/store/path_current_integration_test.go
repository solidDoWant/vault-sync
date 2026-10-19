//go:build integration

package store_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

func requirePathNotCurrent(t require.TestingT, err error, msgAndArgs ...any) {
	require.ErrorIs(t, err, store.ErrPathNotCurrent, msgAndArgs...)
}

// Issue #191: a revision whose path may only be kept (PathMustBeCurrent, a
// path with "\" since the rule) is committed only as an edit or delete in
// place of a live document already at exactly that path. Creating a
// document there, moving one there, or bringing a tombstone back there is
// refused and writes nothing.
func TestPathMustBeCurrent(t *testing.T) {
	const legacy = `notes\old.md`

	tests := []struct {
		name string
		// deleteFirst tombstones the document at its legacy path first.
		deleteFirst bool
		// create commits a new document instead of a successor.
		create    bool
		path      string
		deleted   bool
		assertion require.ErrorAssertionFunc
	}{
		{name: "edit in place", path: legacy},
		{name: "delete in place", path: legacy, deleted: true},
		{name: "move to another path", path: `notes\new.md`, assertion: requirePathNotCurrent},
		{name: "move to a path with the same path key", path: `Notes\old.md`, assertion: requirePathNotCurrent},
		{name: "delete moving to another path", path: `notes\new.md`, deleted: true, assertion: requirePathNotCurrent},
		{name: "resurrect in place", deleteFirst: true, path: legacy, assertion: requirePathNotCurrent},
		{name: "delete a tombstone again", deleteFirst: true, path: legacy, deleted: true, assertion: requirePathNotCurrent},
		{name: "create a new document", create: true, path: `other\new.md`, assertion: requirePathNotCurrent},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCommitFixture(t)

			// Committed as a path that may be created, as before #191.
			head, err := fixture.vault.CommitRevision(t.Context(), fixture.create(legacy, legacy))
			require.NoError(t, err)

			if test.deleteFirst {
				head, err = fixture.vault.CommitRevision(t.Context(), fixture.successor(head, legacy, legacy, true))
				require.NoError(t, err)
			}

			revision := fixture.successor(head, test.path, test.path, test.deleted)
			if test.create {
				revision = fixture.create(test.path, test.path)
			}

			revision.PathMustBeCurrent = true

			before := fixture.headSeq(t)
			_, err = fixture.vault.CommitRevision(t.Context(), revision)

			assertion := test.assertion
			if assertion == nil {
				assertion = require.NoError
			}

			assertion(t, err)

			if err != nil {
				assert.Equal(t, before, fixture.headSeq(t), "nothing is committed")
			} else {
				assert.Equal(t, before+1, fixture.headSeq(t))
			}
		})
	}
}
