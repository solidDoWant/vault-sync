//go:build integration

package store_test

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// Bughunt probe: real concurrency on one vault (creates on colliding path
// keys, edits on one base, retries of one revision id, delete/recreate).
func TestBughuntConcurrentCommits(t *testing.T) {
	fixture := newCommitFixture(t)
	ctx := t.Context()

	const racers = 12

	for round := range 30 {
		key := fmt.Sprintf("p%d.md", round)

		// 1. Concurrent creates on one path key: exactly one wins.
		var wg sync.WaitGroup
		results := make([]error, racers)
		revisions := make([]store.Revision, racers)
		for index := range racers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				revisions[index], results[index] = fixture.vault.CommitRevision(ctx, fixture.create(key, key))
			}()
		}
		wg.Wait()
		var winner store.Revision
		wins := 0
		for index, err := range results {
			if err == nil {
				wins++
				winner = revisions[index]
				continue
			}
			require.ErrorIs(t, err, store.ErrPathKeyTaken, "round %d racer %d", round, index)
		}
		require.Equal(t, 1, wins, "round %d", round)

		// 2. Concurrent edits on the same base plus retries of one revision id.
		edit := fixture.create(key, key)
		edit.DocumentID = winner.DocumentID
		edit.BaseRevID = uuid.NullUUID{UUID: winner.ID, Valid: true}
		for index := range racers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				candidate := edit
				if index%2 == 1 {
					candidate.ID = uuid.Must(uuid.NewV7())
				}
				revisions[index], results[index] = fixture.vault.CommitRevision(ctx, candidate)
			}()
		}
		wg.Wait()
		var retrySeq int64 = -1
		editWins := 0
		for index, err := range results {
			if index%2 == 0 {
				// Same revision id as every other even racer: either all
				// succeed with one seq, or all are stale.
				if err == nil {
					if retrySeq == -1 {
						retrySeq = revisions[index].Seq
					}
					require.Equal(t, retrySeq, revisions[index].Seq, "round %d", round)
					continue
				}
				var moved *store.HeadMovedError
				require.True(t, errors.As(err, &moved), "round %d racer %d: %v", round, index, err)
				require.Equal(t, int64(-1), retrySeq, "round %d: some retries of one id succeeded and some failed", round)
				continue
			}
			if err == nil {
				editWins++
				continue
			}
			var moved *store.HeadMovedError
			require.True(t, errors.As(err, &moved), "round %d racer %d: %v", round, index, err)
		}
		if retrySeq != -1 {
			editWins++
		}
		require.Equal(t, 1, editWins, "round %d", round)

		// 3. Delete vs recreate on the same key.
		document, err := fixture.vault.Document(ctx, winner.DocumentID)
		require.NoError(t, err)
		tombstone := fixture.create(key, key)
		tombstone.DocumentID = winner.DocumentID
		tombstone.BaseRevID = uuid.NullUUID{UUID: document.HeadRevID, Valid: true}
		tombstone.Deleted = true
		recreated := 0
		for index := range racers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if index == 0 {
					_, results[index] = fixture.vault.CommitRevision(ctx, tombstone)
					return
				}
				_, results[index] = fixture.vault.CommitRevision(ctx, fixture.create(key, key))
			}()
		}
		wg.Wait()
		require.NoError(t, results[0], "round %d tombstone", round)
		for index, err := range results[1:] {
			if err == nil {
				recreated++
				continue
			}
			require.ErrorIs(t, err, store.ErrPathKeyTaken, "round %d racer %d", round, index+1)
		}
		require.LessOrEqual(t, recreated, 1, "round %d", round)
	}

	// Seq is gapless.
	var count, head int64
	require.NoError(t, fixture.pool.QueryRow(ctx, "SELECT count(*), max(seq) FROM revisions WHERE vault_id = $1", fixture.vault.VaultID()).Scan(&count, &head))
	require.Equal(t, count, head)
	require.Equal(t, head, fixture.headSeq(t))
}

// Bughunt probe: readers paging the change feed while writers commit never
// see a gap or a reordering, and every page's head_seq covers it.
func TestBughuntChangeFeedUnderConcurrentCommits(t *testing.T) {
	fixture := newCommitFixture(t)
	ctx := t.Context()

	const writers, commitsPerWriter, readers = 8, 40, 4

	done := make(chan struct{})

	var readerGroup sync.WaitGroup

	readerErrors := make([]error, readers)

	for reader := range readers {
		readerGroup.Add(1)

		go func() {
			defer readerGroup.Done()

			var cursor int64

			for {
				select {
				case <-done:
					if cursor < writers*commitsPerWriter {
						// drain to the end
					} else {
						return
					}
				default:
				}

				changes, err := fixture.vault.ListChanges(ctx, cursor, 1+reader)
				if err != nil {
					readerErrors[reader] = err

					return
				}

				for _, revision := range changes.Revisions {
					if revision.Seq != cursor+1 {
						readerErrors[reader] = fmt.Errorf("reader %d: seq %d after %d", reader, revision.Seq, cursor)

						return
					}

					cursor = revision.Seq
				}

				if changes.HeadSeq < cursor {
					readerErrors[reader] = fmt.Errorf("reader %d: head_seq %d below cursor %d", reader, changes.HeadSeq, cursor)

					return
				}

				if !changes.HasMore && changes.HeadSeq != cursor {
					readerErrors[reader] = fmt.Errorf("reader %d: has_more=false at cursor %d but head_seq %d", reader, cursor, changes.HeadSeq)

					return
				}
			}
		}()
	}

	var writerGroup sync.WaitGroup

	for writer := range writers {
		writerGroup.Add(1)

		go func() {
			defer writerGroup.Done()

			for index := range commitsPerWriter {
				key := fmt.Sprintf("w%d-%d.md", writer, index)
				_, err := fixture.vault.CommitRevision(ctx, fixture.create(key, key))
				assert.NoError(t, err)
			}
		}()
	}

	writerGroup.Wait()
	close(done)
	readerGroup.Wait()

	for _, err := range readerErrors {
		require.NoError(t, err)
	}
}
