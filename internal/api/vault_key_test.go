package api_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"math"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// keyRecorder records what reaches the vault key store; out-of-bounds input
// must be refused before any call.
type keyRecorder struct {
	calls       int
	limit       int
	after       int32
	afterUser   uuid.UUID
	kind        store.RecipientKind
	recipientID string
	next        store.NextEpoch
	slots       []store.KeySlot
	// listed is how many entries each list returns.
	listed int
	err    error
}

func (recorder *keyRecorder) KeyState(context.Context) (store.KeyState, error) {
	recorder.calls++

	return store.KeyState{Encryption: store.EncryptionE2EE, CurrentEpoch: 3, RotationPending: true}, recorder.err
}

func (recorder *keyRecorder) ListEpochs(_ context.Context, after int32, limit int) ([]store.Epoch, error) {
	recorder.calls++
	recorder.after, recorder.limit = after, limit

	epochs := make([]store.Epoch, recorder.listed)
	for index := range epochs {
		epochs[index] = store.Epoch{Epoch: after + int32(index) + 1, Commitment: bytes.Repeat([]byte{1}, 32)} //nolint:gosec // small test values.
	}

	return epochs, recorder.err
}

func (recorder *keyRecorder) ListKeySlots(_ context.Context, kind store.RecipientKind, recipientID string, after int32, limit int) ([]store.KeySlot, error) {
	recorder.calls++
	recorder.kind, recorder.recipientID, recorder.after, recorder.limit = kind, recipientID, after, limit

	slots := make([]store.KeySlot, recorder.listed)
	for index := range slots {
		slots[index] = store.KeySlot{Epoch: after + int32(index) + 1, RecipientKind: kind, RecipientID: recipientID, WrappedKey: []byte{1}} //nolint:gosec // small test values.
	}

	return slots, recorder.err
}

func (recorder *keyRecorder) ListEscrowSlots(_ context.Context, after int32, limit int) ([]store.KeySlot, error) {
	recorder.calls++
	recorder.kind, recorder.recipientID, recorder.after, recorder.limit = store.RecipientEscrow, "", after, limit

	slots := make([]store.KeySlot, recorder.listed)
	for index := range slots {
		slots[index] = store.KeySlot{Epoch: after + int32(index) + 1, RecipientKind: store.RecipientEscrow, RecipientID: "escrow-key", WrappedKey: []byte{1}} //nolint:gosec // small test values.
	}

	return slots, recorder.err
}

func (recorder *keyRecorder) ListMissingSlots(_ context.Context, afterEpoch int32, afterUser uuid.UUID, limit int) ([]store.MissingSlot, error) {
	recorder.calls++
	recorder.after, recorder.afterUser, recorder.limit = afterEpoch, afterUser, limit

	missing := make([]store.MissingSlot, recorder.listed)
	for index := range missing {
		missing[index] = store.MissingSlot{Epoch: afterEpoch + int32(index) + 1, UserID: uuid.New(), PublicKey: make([]byte, 32)} //nolint:gosec // small test values.
	}

	return missing, recorder.err
}

func (recorder *keyRecorder) RotateEpoch(_ context.Context, _ uuid.UUID, next store.NextEpoch) (store.Epoch, error) {
	recorder.calls++
	recorder.next = next

	return store.Epoch{Epoch: next.ExpectedEpoch + 1, Commitment: next.Commitment}, recorder.err
}

func (recorder *keyRecorder) AddKeySlots(_ context.Context, _ uuid.UUID, slots []store.KeySlot) (int, error) {
	recorder.calls++
	recorder.slots = slots

	return len(slots), recorder.err
}

func (recorder *keyRecorder) ListLogEntries(_ context.Context, after int64, limit int) ([]store.LogEntry, error) {
	recorder.calls++
	recorder.after, recorder.limit = int32(after), limit //nolint:gosec // small test values.

	entries := make([]store.LogEntry, recorder.listed)
	for index := range entries {
		entries[index] = store.LogEntry{Seq: after + int64(index) + 1, PrevHash: make([]byte, 32), Type: 1, Signatures: [][]byte{{byte(after) + byte(index) + 1}}} //nolint:gosec // small test values.
	}

	return entries, recorder.err
}

var keyCaller = auth.User{ID: uuid.MustParse("01920000-0000-7000-8000-000000000001"), Identity: auth.Identity{Issuer: "https://issuer.example", Subject: "alice"}}

// keyEscrow is the escrow key of keyService: its current id, and a retiring
// id at the recipient id bound.
var keyEscrow = api.Escrow{PublicKey: []byte{1}, KeyID: "escrow-key", RetiringKeyIDs: []string{strings.Repeat("e", 255)}}

func keyService(recorder *keyRecorder) (api.VaultKeyService, context.Context) {
	service := api.VaultKeyService{Keys: func(uuid.UUID) api.VaultKeyStore { return recorder }, Escrow: keyEscrow}
	ctx := authz.WithMembership(auth.WithUser(context.Background(), keyCaller), authz.Membership{VaultID: uuid.New(), Role: store.RoleOwner})

	return service, ctx
}

func userSlot(epoch uint32) *vaultsyncv1.KeySlot {
	return &vaultsyncv1.KeySlot{
		Epoch:         epoch,
		RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER,
		RecipientId:   uuid.Must(uuid.NewV7()).String(),
		WrappedKey:    bytes.Repeat([]byte{9}, 105),
	}
}

func validNextEpoch() *vaultsyncv1.NextEpoch {
	return &vaultsyncv1.NextEpoch{ExpectedEpoch: 4, Commitment: bytes.Repeat([]byte{5}, 32), Slots: []*vaultsyncv1.KeySlot{userSlot(0)}}
}

func requireCode(t *testing.T, want connect.Code, err error) {
	t.Helper()

	if want == 0 {
		require.NoError(t, err)

		return
	}

	require.Error(t, err)
	assert.Equal(t, want, connect.CodeOf(err), err)
}

// slotCases are bounds of a single key slot, written out here (SPEC.md
// §9.3), each just inside or just outside a bound.
func slotCases() []struct {
	name     string
	mutate   func(*vaultsyncv1.KeySlot)
	accepted bool
} {
	return []struct {
		name     string
		mutate   func(*vaultsyncv1.KeySlot)
		accepted bool
	}{
		{"wrapped key of 1 byte", func(slot *vaultsyncv1.KeySlot) { slot.WrappedKey = []byte{1} }, true},
		{"wrapped key of 2048 bytes", func(slot *vaultsyncv1.KeySlot) { slot.WrappedKey = make([]byte, 2048) }, true},
		{"empty wrapped key", func(slot *vaultsyncv1.KeySlot) { slot.WrappedKey = nil }, false},
		{"wrapped key of 2049 bytes", func(slot *vaultsyncv1.KeySlot) { slot.WrappedKey = make([]byte, 2049) }, false},
		{"unspecified recipient kind", func(slot *vaultsyncv1.KeySlot) {
			slot.RecipientKind = vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_UNSPECIFIED
		}, false},
		{"unknown recipient kind", func(slot *vaultsyncv1.KeySlot) { slot.RecipientKind = 7 }, false},
		{"user id in upper case", func(slot *vaultsyncv1.KeySlot) { slot.RecipientId = strings.ToUpper(slot.GetRecipientId()) }, false},
		{"user id that is not a UUID", func(slot *vaultsyncv1.KeySlot) { slot.RecipientId = "alice" }, false},
		{"escrow id of 255 bytes", func(slot *vaultsyncv1.KeySlot) {
			slot.RecipientKind = vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW
			slot.RecipientId = strings.Repeat("e", 255)
		}, true},
		{"escrow id of 256 bytes", func(slot *vaultsyncv1.KeySlot) {
			slot.RecipientKind = vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW
			slot.RecipientId = strings.Repeat("e", 256)
		}, false},
		{"empty escrow id", func(slot *vaultsyncv1.KeySlot) {
			slot.RecipientKind = vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW
			slot.RecipientId = ""
		}, false},
		{"escrow id with a space", func(slot *vaultsyncv1.KeySlot) {
			slot.RecipientKind = vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW
			slot.RecipientId = "escrow key"
		}, false},
	}
}

func TestRotateEpochBoundsEveryFieldBeforeTheStore(t *testing.T) {
	type testCase struct {
		name     string
		mutate   func(*vaultsyncv1.NextEpoch)
		accepted bool
	}

	cases := []testCase{
		{"valid", func(*vaultsyncv1.NextEpoch) {}, true},
		{"commitment of 31 bytes", func(next *vaultsyncv1.NextEpoch) { next.Commitment = make([]byte, 31) }, false},
		{"commitment of 33 bytes", func(next *vaultsyncv1.NextEpoch) { next.Commitment = make([]byte, 33) }, false},
		{"no commitment", func(next *vaultsyncv1.NextEpoch) { next.Commitment = nil }, false},
		{"201 slots: every member, every pending invitation and escrow", func(next *vaultsyncv1.NextEpoch) {
			next.Slots = nil
			for range 201 {
				next.Slots = append(next.Slots, userSlot(0))
			}
		}, true},
		{"202 slots", func(next *vaultsyncv1.NextEpoch) {
			next.Slots = nil
			for range 202 {
				next.Slots = append(next.Slots, userSlot(0))
			}
		}, false},
		{"two slots for one user", func(next *vaultsyncv1.NextEpoch) {
			next.Slots = append(next.Slots, userSlot(0))
			next.Slots[1].RecipientId = next.Slots[0].GetRecipientId()
		}, false},
		{"expected epoch below the largest", func(next *vaultsyncv1.NextEpoch) { next.ExpectedEpoch = math.MaxInt32 - 1 }, true},
		{"expected epoch at the largest", func(next *vaultsyncv1.NextEpoch) { next.ExpectedEpoch = math.MaxInt32 }, false},
	}

	for _, slotCase := range slotCases() {
		cases = append(cases, testCase{"slot with " + slotCase.name, func(next *vaultsyncv1.NextEpoch) { slotCase.mutate(next.Slots[0]) }, slotCase.accepted})
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := &keyRecorder{}
			service, ctx := keyService(recorder)
			next := validNextEpoch()
			testCase.mutate(next)

			response, err := service.RotateEpoch(ctx, connect.NewRequest(&vaultsyncv1.RotateEpochRequest{NextEpoch: next}))
			if !testCase.accepted {
				requireCode(t, connect.CodeInvalidArgument, err)
				assert.Zero(t, recorder.calls, "refused before the store")

				return
			}

			require.NoError(t, err)
			assert.Equal(t, 1, recorder.calls)
			assert.Equal(t, int32(next.GetExpectedEpoch()), recorder.next.ExpectedEpoch) //nolint:gosec // test values are in range.
			assert.Equal(t, next.GetCommitment(), recorder.next.Commitment)
			assert.Len(t, recorder.next.Slots, len(next.GetSlots()))
			assert.Equal(t, next.GetExpectedEpoch()+1, response.Msg.GetEpoch().GetEpoch())
		})
	}

	t.Run("no next epoch", func(t *testing.T) {
		recorder := &keyRecorder{}
		service, ctx := keyService(recorder)

		_, err := service.RotateEpoch(ctx, connect.NewRequest(&vaultsyncv1.RotateEpochRequest{}))
		requireCode(t, connect.CodeInvalidArgument, err)
		assert.Zero(t, recorder.calls)
	})
}

func TestAddKeySlotsBoundsEveryFieldBeforeTheStore(t *testing.T) {
	type testCase struct {
		name     string
		slots    func() []*vaultsyncv1.KeySlot
		accepted bool
	}

	repeated := func(count int) func() []*vaultsyncv1.KeySlot {
		return func() []*vaultsyncv1.KeySlot {
			slots := make([]*vaultsyncv1.KeySlot, count)
			for index := range slots {
				slots[index] = userSlot(1)
			}

			return slots
		}
	}
	one := func(mutate func(*vaultsyncv1.KeySlot)) func() []*vaultsyncv1.KeySlot {
		return func() []*vaultsyncv1.KeySlot {
			slot := userSlot(1)
			mutate(slot)

			return []*vaultsyncv1.KeySlot{slot}
		}
	}

	cases := []testCase{
		{"one slot", repeated(1), true},
		{"1000 slots", repeated(1000), true},
		{"1001 slots", repeated(1001), false},
		{"no slots", repeated(0), false},
		{"epoch 0", one(func(slot *vaultsyncv1.KeySlot) { slot.Epoch = 0 }), false},
		{"largest epoch", one(func(slot *vaultsyncv1.KeySlot) { slot.Epoch = math.MaxInt32 }), true},
		{"epoch past the largest", one(func(slot *vaultsyncv1.KeySlot) { slot.Epoch = math.MaxInt32 + 1 }), false},
		{"two slots for one epoch and user", func() []*vaultsyncv1.KeySlot {
			first := userSlot(2)
			second := userSlot(2)
			second.RecipientId = first.GetRecipientId()

			return []*vaultsyncv1.KeySlot{first, second}
		}, false},
		{"one user's slots for two epochs", func() []*vaultsyncv1.KeySlot {
			first := userSlot(1)
			second := userSlot(2)
			second.RecipientId = first.GetRecipientId()

			return []*vaultsyncv1.KeySlot{first, second}
		}, true},
	}

	for _, slotCase := range slotCases() {
		cases = append(cases, testCase{"slot with " + slotCase.name, one(slotCase.mutate), slotCase.accepted})
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := &keyRecorder{}
			service, ctx := keyService(recorder)
			slots := testCase.slots()

			response, err := service.AddKeySlots(ctx, connect.NewRequest(&vaultsyncv1.AddKeySlotsRequest{Slots: slots}))
			if !testCase.accepted {
				requireCode(t, connect.CodeInvalidArgument, err)
				assert.Zero(t, recorder.calls, "refused before the store")

				return
			}

			require.NoError(t, err)
			require.Len(t, recorder.slots, len(slots))
			assert.Equal(t, uint32(len(slots)), response.Msg.GetAdded()) //nolint:gosec // small test values.

			for index, slot := range slots {
				assert.Equal(t, int32(slot.GetEpoch()), recorder.slots[index].Epoch) //nolint:gosec // test values are in range.
				assert.Equal(t, slot.GetRecipientId(), recorder.slots[index].RecipientID)
				assert.Equal(t, slot.GetWrappedKey(), recorder.slots[index].WrappedKey)
			}
		})
	}
}

// The lists are paginated: page_size defaults to 100 and is capped at 1000,
// and a malformed page_token is refused before the store.
func TestVaultKeyListsArePaginated(t *testing.T) {
	type list func(service api.VaultKeyService, ctx context.Context, pageSize uint32, token string) (string, int, error)

	lists := map[string]list{
		"ListKeySlots": func(service api.VaultKeyService, ctx context.Context, pageSize uint32, token string) (string, int, error) {
			response, err := service.ListKeySlots(ctx, connect.NewRequest(&vaultsyncv1.ListKeySlotsRequest{PageSize: pageSize, PageToken: token}))
			if err != nil {
				return "", 0, err
			}

			return response.Msg.GetNextPageToken(), len(response.Msg.GetSlots()), nil
		},
		"ListEpochs": func(service api.VaultKeyService, ctx context.Context, pageSize uint32, token string) (string, int, error) {
			response, err := service.ListEpochs(ctx, connect.NewRequest(&vaultsyncv1.ListEpochsRequest{PageSize: pageSize, PageToken: token}))
			if err != nil {
				return "", 0, err
			}

			return response.Msg.GetNextPageToken(), len(response.Msg.GetEpochs()), nil
		},
		"ListMissingSlots": func(service api.VaultKeyService, ctx context.Context, pageSize uint32, token string) (string, int, error) {
			response, err := service.ListMissingSlots(ctx, connect.NewRequest(&vaultsyncv1.ListMissingSlotsRequest{PageSize: pageSize, PageToken: token}))
			if err != nil {
				return "", 0, err
			}

			return response.Msg.GetNextPageToken(), len(response.Msg.GetMissingSlots()), nil
		},
		"ListLogEntries": func(service api.VaultKeyService, ctx context.Context, pageSize uint32, token string) (string, int, error) {
			response, err := service.ListLogEntries(ctx, connect.NewRequest(&vaultsyncv1.ListLogEntriesRequest{PageSize: pageSize, PageToken: token}))
			if err != nil {
				return "", 0, err
			}

			return response.Msg.GetNextPageToken(), len(response.Msg.GetEntries()), nil
		},
	}

	for name, call := range lists {
		t.Run(name+" page sizes", func(t *testing.T) {
			for _, size := range []struct{ requested, want uint32 }{{0, 100}, {1, 1}, {1000, 1000}, {1001, 1000}} {
				recorder := &keyRecorder{}
				service, ctx := keyService(recorder)

				_, _, err := call(service, ctx, size.requested, "")
				require.NoError(t, err)
				assert.Equal(t, int(size.want), recorder.limit, "page_size %d", size.requested)
			}
		})

		t.Run(name+" continues after a full page", func(t *testing.T) {
			recorder := &keyRecorder{listed: 2}
			service, ctx := keyService(recorder)

			token, count, err := call(service, ctx, 2, "")
			require.NoError(t, err)
			assert.Equal(t, 2, count)
			require.NotEmpty(t, token)

			_, _, err = call(service, ctx, 2, token)
			require.NoError(t, err)
			assert.Equal(t, int32(2), recorder.after, "the next page starts after the last epoch")

			recorder.listed = 1

			token, _, err = call(service, ctx, 2, token)
			require.NoError(t, err)
			assert.Empty(t, token, "a short page is the last")
		})

		t.Run(name+" malformed tokens", func(t *testing.T) {
			for _, token := range []string{"!!", base64.RawURLEncoding.EncodeToString([]byte{0, 0, 1}), base64.RawURLEncoding.EncodeToString(make([]byte, 40)),
				base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xff}, 20)), base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xff}, 8))} {
				recorder := &keyRecorder{}
				service, ctx := keyService(recorder)

				_, _, err := call(service, ctx, 0, token)
				requireCode(t, connect.CodeInvalidArgument, err)
				assert.Zero(t, recorder.calls, "token %q refused before the store", token)
			}
		})
	}
}

// Criterion 1: ListKeySlots names only the caller's own slots; the request
// cannot name another recipient.
func TestListKeySlotsListsTheCallersSlotsOnly(t *testing.T) {
	recorder := &keyRecorder{listed: 1}
	service, ctx := keyService(recorder)

	response, err := service.ListKeySlots(ctx, connect.NewRequest(&vaultsyncv1.ListKeySlotsRequest{}))
	require.NoError(t, err)
	assert.Equal(t, store.RecipientUser, recorder.kind)
	assert.Equal(t, keyCaller.ID.String(), recorder.recipientID)
	require.Len(t, response.Msg.GetSlots(), 1)
	assert.Equal(t, vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER, response.Msg.GetSlots()[0].GetRecipientKind())
}

func TestListKeySlotsListsEscrowSlotsToEditorsAndOwnersOnly(t *testing.T) {
	escrowRequest := func() *connect.Request[vaultsyncv1.ListKeySlotsRequest] {
		return connect.NewRequest(&vaultsyncv1.ListKeySlotsRequest{RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW})
	}

	for _, role := range []store.Role{store.RoleOwner, store.RoleEditor} {
		t.Run(string(role), func(t *testing.T) {
			recorder := &keyRecorder{listed: 2}
			service := api.VaultKeyService{Keys: func(uuid.UUID) api.VaultKeyStore { return recorder }}
			ctx := authz.WithMembership(auth.WithUser(t.Context(), keyCaller), authz.Membership{VaultID: uuid.New(), Role: role})

			response, err := service.ListKeySlots(ctx, escrowRequest())
			require.NoError(t, err)
			assert.Equal(t, store.RecipientEscrow, recorder.kind)
			require.Len(t, response.Msg.GetSlots(), 2)

			for index, slot := range response.Msg.GetSlots() {
				assert.Equal(t, uint32(index+1), slot.GetEpoch()) //nolint:gosec // small test values.
				assert.Equal(t, vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW, slot.GetRecipientKind())
				assert.Equal(t, "escrow-key", slot.GetRecipientId())
			}
		})
	}

	t.Run("viewer", func(t *testing.T) {
		recorder := &keyRecorder{listed: 2}
		service := api.VaultKeyService{Keys: func(uuid.UUID) api.VaultKeyStore { return recorder }}
		ctx := authz.WithMembership(auth.WithUser(t.Context(), keyCaller), authz.Membership{VaultID: uuid.New(), Role: store.RoleViewer})

		_, err := service.ListKeySlots(ctx, escrowRequest())
		requireCode(t, connect.CodePermissionDenied, err)
		assert.Zero(t, recorder.calls)

		response, err := service.ListKeySlots(ctx, connect.NewRequest(&vaultsyncv1.ListKeySlotsRequest{}))
		require.NoError(t, err, "a viewer still lists their own slots")
		assert.Len(t, response.Msg.GetSlots(), 2)
		assert.Equal(t, store.RecipientUser, recorder.kind)
	})

	t.Run("unknown recipient kind", func(t *testing.T) {
		recorder := &keyRecorder{listed: 2}
		service, ctx := keyService(recorder)

		_, err := service.ListKeySlots(ctx, connect.NewRequest(&vaultsyncv1.ListKeySlotsRequest{RecipientKind: vaultsyncv1.KeyRecipientKind(99)}))
		requireCode(t, connect.CodeInvalidArgument, err)
		assert.Zero(t, recorder.calls)
	})

	t.Run("explicit user kind lists the caller's own slots", func(t *testing.T) {
		recorder := &keyRecorder{listed: 1}
		service, ctx := keyService(recorder)

		_, err := service.ListKeySlots(ctx, connect.NewRequest(&vaultsyncv1.ListKeySlotsRequest{RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER}))
		require.NoError(t, err)
		assert.Equal(t, store.RecipientUser, recorder.kind)
		assert.Equal(t, keyCaller.ID.String(), recorder.recipientID)
	})
}

func TestListEpochsReportsTheKeyState(t *testing.T) {
	recorder := &keyRecorder{}
	service, ctx := keyService(recorder)

	response, err := service.ListEpochs(ctx, connect.NewRequest(&vaultsyncv1.ListEpochsRequest{}))
	require.NoError(t, err)
	assert.Equal(t, uint32(3), response.Msg.GetCurrentEpoch())
	assert.True(t, response.Msg.GetRotationPending())
}

func TestKeyStoreErrorsMapToCodesAndReasons(t *testing.T) {
	cases := []struct {
		err    error
		code   connect.Code
		reason vaultsyncv1.ErrorReason
	}{
		{store.ErrEpochNotCurrent, connect.CodeFailedPrecondition, vaultsyncv1.ErrorReason_ERROR_REASON_EPOCH_NOT_CURRENT},
		{store.ErrNotEncrypted, connect.CodeFailedPrecondition, vaultsyncv1.ErrorReason_ERROR_REASON_UNSPECIFIED},
		{fmt.Errorf("%w: no slot for member", store.ErrInvalidRecipients), connect.CodeInvalidArgument, vaultsyncv1.ErrorReason_ERROR_REASON_UNSPECIFIED},
		{store.ErrEpochNotFound, connect.CodeInvalidArgument, vaultsyncv1.ErrorReason_ERROR_REASON_UNSPECIFIED},
	}

	for _, testCase := range cases {
		t.Run(testCase.err.Error(), func(t *testing.T) {
			recorder := &keyRecorder{err: testCase.err}
			service, ctx := keyService(recorder)

			_, err := service.RotateEpoch(ctx, connect.NewRequest(&vaultsyncv1.RotateEpochRequest{NextEpoch: validNextEpoch()}))
			requireCode(t, testCase.code, err)
			assert.Equal(t, testCase.reason, api.ErrorReasonOf(err))

			_, err = service.AddKeySlots(ctx, connect.NewRequest(&vaultsyncv1.AddKeySlotsRequest{Slots: []*vaultsyncv1.KeySlot{userSlot(1)}}))
			requireCode(t, testCase.code, err)
		})
	}
}

func TestEscrowSlotsMustNameTheCurrentOrARetiringEscrowKey(t *testing.T) {
	escrowSlot := func(epoch uint32, id string) *vaultsyncv1.KeySlot {
		return &vaultsyncv1.KeySlot{
			Epoch:         epoch,
			RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW,
			RecipientId:   id,
			WrappedKey:    bytes.Repeat([]byte{9}, 105),
		}
	}

	escrow := api.Escrow{PublicKey: []byte{1}, KeyID: "current-key", RetiringKeyIDs: []string{"retiring-key", "older-key"}}

	tests := []struct {
		name     string
		escrow   api.Escrow
		id       string
		accepted bool
	}{
		{name: "the current escrow key", escrow: escrow, id: "current-key", accepted: true},
		{name: "a retiring escrow key", escrow: escrow, id: "retiring-key", accepted: true},
		{name: "another retiring escrow key", escrow: escrow, id: "older-key", accepted: true},
		{name: "an unknown escrow key", escrow: escrow, id: "unknown-key"},
		{name: "a prefix of the current escrow key", escrow: escrow, id: "current"},
		{name: "a deployment without an escrow key", escrow: api.Escrow{}, id: "current-key"},
		{name: "a deployment with only a retiring id but no escrow key", escrow: api.Escrow{RetiringKeyIDs: []string{"retiring-key"}}, id: "retiring-key"},
	}

	for _, test := range tests {
		want := connect.CodeInvalidArgument
		if test.accepted {
			want = 0
		}

		t.Run("RotateEpoch with "+test.name, func(t *testing.T) {
			recorder := &keyRecorder{}
			service, ctx := keyService(recorder)
			service.Escrow = test.escrow

			next := validNextEpoch()
			next.Slots = append(next.Slots, escrowSlot(0, test.id))

			_, err := service.RotateEpoch(ctx, connect.NewRequest(&vaultsyncv1.RotateEpochRequest{NextEpoch: next}))
			requireCode(t, want, err)
			assert.Equal(t, test.accepted, recorder.calls == 1, "the store is reached only for an accepted escrow slot")
		})

		t.Run("AddKeySlots with "+test.name, func(t *testing.T) {
			recorder := &keyRecorder{}
			service, ctx := keyService(recorder)
			service.Escrow = test.escrow

			_, err := service.AddKeySlots(ctx, connect.NewRequest(&vaultsyncv1.AddKeySlotsRequest{Slots: []*vaultsyncv1.KeySlot{userSlot(1), escrowSlot(1, test.id)}}))
			requireCode(t, want, err)
			assert.Equal(t, test.accepted, recorder.calls == 1, "the store is reached only for an accepted escrow slot")
		})
	}
}
