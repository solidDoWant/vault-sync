package e2ee

import (
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/hex"
	"maps"
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Vectors for identity keys, the membership log, signed epochs, anchors and
// escrow bundles (docs/design/crypto.md "Identity keys, the membership log
// and signed epochs").

type identityVector struct {
	Name               string `json:"name"`
	UserID             string `json:"user_id"`
	UserSecret         string `json:"user_secret"`
	SignPub            string `json:"sign_pub"`
	KEMPub             string `json:"kem_pub"`
	Bundle             string `json:"bundle"`
	Fingerprint        string `json:"fingerprint"`
	FingerprintDisplay string `json:"fingerprint_display"`
	AnchorKey          string `json:"anchor_key"`
}

type inviteSignVector struct {
	Name         string `json:"name"`
	Secret       string `json:"secret"`
	VaultID      string `json:"vault_id"`
	InvitationID string `json:"invitation_id"`
	Seed         string `json:"seed"`
	SignPub      string `json:"sign_pub"`
}

type invitationKeyVector struct {
	Name         string `json:"name"`
	Secret       string `json:"secret"`
	VaultID      string `json:"vault_id"`
	InvitationID string `json:"invitation_id"`
	PrivateKey   string `json:"private_key"`
	PublicKey    string `json:"public_key"`
	AgeIdentity  string `json:"age_identity"`
	AgeRecipient string `json:"age_recipient"`
}

type inviteAnchorVector struct {
	Name               string `json:"name"`
	Secret             string `json:"secret"`
	VaultID            string `json:"vault_id"`
	InvitationID       string `json:"invitation_id"`
	GenesisHash        string `json:"genesis_hash,omitempty"`
	InviterFingerprint string `json:"inviter_fingerprint,omitempty"`
	MACKey             string `json:"mac_key,omitempty"`
	Anchor             string `json:"anchor"`
}

type anchorJSON struct {
	VaultID     string `json:"vault_id"`
	GenesisHash string `json:"genesis_hash"`
}

type anchorListVector struct {
	Name      string       `json:"name"`
	AnchorKey string       `json:"anchor_key"`
	UserID    string       `json:"user_id"`
	Version   uint64       `json:"version"`
	Nonce     string       `json:"nonce"`
	Anchors   []anchorJSON `json:"anchors"`
	Sealed    string       `json:"sealed"`
}

type rejectedAnchorListVector struct {
	Name      string `json:"name"`
	AnchorKey string `json:"anchor_key"`
	UserID    string `json:"user_id"`
	Version   uint64 `json:"version"`
	Sealed    string `json:"sealed"`
}

type escrowBundleVector struct {
	Name      string `json:"name"`
	SignSeed  string `json:"sign_seed"`
	SignPub   string `json:"sign_pub"`
	Recipient string `json:"recipient"`
	Encoded   string `json:"encoded"`
	// Fingerprint is the escrow fingerprint, FingerprintDisplay as shown.
	Fingerprint        string `json:"fingerprint"`
	FingerprintDisplay string `json:"fingerprint_display"`
}

type escrowRotationJSON struct {
	OldBundleHash string `json:"old_bundle_hash"`
	NewBundle     string `json:"new_bundle"`
	Signature     string `json:"signature"`
}

type escrowChainVector struct {
	Name      string               `json:"name"`
	Pinned    string               `json:"pinned"`
	Rotations []escrowRotationJSON `json:"rotations"`
	// Result is the encoded bundle the chain ends at; empty for a rejected chain.
	Result string `json:"result,omitempty"`
}

type entryJSON struct {
	Seq      uint64 `json:"seq"`
	PrevHash string `json:"prev_hash"`
	Type     uint8  `json:"type"`
	Payload  string `json:"payload"`
	// SignerSeeds are the Ed25519 seeds that sign the entry, in signature order.
	SignerSeeds []string `json:"signer_seeds"`
	Signatures  []string `json:"signatures"`
	Hash        string   `json:"hash"`
}

type memberJSON struct {
	UserID      string `json:"user_id"`
	Role        uint8  `json:"role"`
	Fingerprint string `json:"fingerprint"`
}

type invitationJSON struct {
	ID         string `json:"id"`
	Role       uint8  `json:"role"`
	SignPub    string `json:"sign_pub"`
	KEMPubHash string `json:"kem_pub_hash"`
}

type logStateJSON struct {
	Seq         uint64           `json:"seq"`
	Hash        string           `json:"hash"`
	Members     []memberJSON     `json:"members"`
	Invitations []invitationJSON `json:"invitations"`
	// Escrow is the encoded escrow bundle, empty when escrow is off.
	Escrow string `json:"escrow"`
	// ConvertedAtSeq is the members entry's bound of a converted vault's
	// plaintext history, absent for a vault created encrypted.
	ConvertedAtSeq *uint64 `json:"converted_at_seq,omitempty"`
}

type recipientJSON struct {
	Kind    uint8  `json:"kind"`
	ID      string `json:"id"`
	KeyHash string `json:"key_hash"`
}

type epochRecordJSON struct {
	Name           string          `json:"name"`
	Epoch          uint64          `json:"epoch"`
	Commitment     string          `json:"commitment"`
	PrevCommitment string          `json:"prev_commitment"`
	LogSeq         uint64          `json:"log_seq"`
	LogHash        string          `json:"log_hash"`
	Recipients     []recipientJSON `json:"recipients"`
	SignerSeed     string          `json:"signer_seed"`
	Body           string          `json:"body,omitempty"`
	Signature      string          `json:"signature"`
}

// epochPositionsVector lists the log positions of the records of epochs 1
// to N (log_seqs[i] is epoch i+1's), against the membership log vector.
type epochPositionsVector struct {
	Name    string   `json:"name"`
	LogSeqs []uint64 `json:"log_seqs"`
}

type membershipLogVector struct {
	VaultID         string               `json:"vault_id"`
	EscrowRotations []escrowRotationJSON `json:"escrow_rotations"`
	Entries         []entryJSON          `json:"entries"`
	States          []logStateJSON       `json:"states"`
	EpochRecords    []epochRecordJSON    `json:"epoch_records"`
}

type rejectedLogVector struct {
	Name            string               `json:"name"`
	VaultID         string               `json:"vault_id"`
	GenesisHash     string               `json:"genesis_hash,omitempty"`
	EscrowRotations []escrowRotationJSON `json:"escrow_rotations"`
	Entries         []entryJSON          `json:"entries"`
}

type identityVectors struct {
	Identity               []identityVector           `json:"identity"`
	InviteSign             []inviteSignVector         `json:"invite_sign"`
	InvitationKey          []invitationKeyVector      `json:"invitation_key"`
	InviteAnchor           []inviteAnchorVector       `json:"invite_anchor"`
	RejectedInviteAnchors  []inviteAnchorVector       `json:"rejected_invite_anchors"`
	AnchorList             []anchorListVector         `json:"anchor_list"`
	RejectedAnchorLists    []rejectedAnchorListVector `json:"rejected_anchor_lists"`
	EscrowBundles          []escrowBundleVector       `json:"escrow_bundles"`
	EscrowChains           []escrowChainVector        `json:"escrow_chains"`
	RejectedEscrowChains   []escrowChainVector        `json:"rejected_escrow_chains"`
	MembershipLog          membershipLogVector        `json:"membership_log"`
	ConvertedLog           membershipLogVector        `json:"converted_log"`
	RejectedLogs           []rejectedLogVector        `json:"rejected_logs"`
	RejectedEpochRecords   []epochRecordJSON          `json:"rejected_epoch_records"`
	EpochPositions         []epochPositionsVector     `json:"epoch_positions"`
	RejectedEpochPositions []epochPositionsVector     `json:"rejected_epoch_positions"`
}

const (
	vectorAliceID       = "0190d6e5-0000-7000-8000-00000000a11c"
	vectorBobID         = "0190d6e5-0000-7000-8000-000000000b0b"
	vectorCarolID       = "0190d6e5-0000-7000-8000-0000000ca201"
	vectorInvitationOne = "0190d6e6-0000-7000-8000-000000000001"
	vectorInvitationTwo = "0190d6e6-0000-7000-8000-000000000002"
	vectorInvitationSix = "0190d6e6-0000-7000-8000-000000000006"
)

type vectorUser struct {
	id     string
	secret UserSecret
	bundle Bundle
}

func newVectorUser(name, id string) vectorUser {
	secret := must(ParseUserSecret(fixed("user secret "+name, UserSecretSize)))

	return vectorUser{id: id, secret: secret, bundle: must(secret.Bundle(id))}
}

func newEscrowBundle(name string) (EscrowBundle, []byte) {
	seed := fixed("escrow sign seed "+name, ed25519.SeedSize)
	signPub, _ := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)

	return EscrowBundle{SignPub: signPub, Recipient: must(AgeRecipient(must(PublicKey(fixed("escrow kem "+name, PrivateKeySize)))))}, seed
}

func rotationJSON(rotation EscrowRotation) escrowRotationJSON {
	return escrowRotationJSON{
		OldBundleHash: hex.EncodeToString(rotation.OldBundleHash),
		NewBundle:     hex.EncodeToString(must(rotation.NewBundle.Encode())),
		Signature:     hex.EncodeToString(rotation.Signature),
	}
}

// logBuilder appends signed entries to a vault's log.
type logBuilder struct {
	vaultID string
	entries []entryJSON
}

func (builder *logBuilder) add(entryType EntryType, payload []byte, signerSeeds ...[]byte) {
	prevHash := make([]byte, HashSize)
	if len(builder.entries) > 0 {
		prevHash = must(hex.DecodeString(builder.entries[len(builder.entries)-1].Hash))
	}

	builder.addRaw(uint64(len(builder.entries))+1, prevHash, entryType, payload, signerSeeds...)
}

func (builder *logBuilder) addRaw(seq uint64, prevHash []byte, entryType EntryType, payload []byte, signerSeeds ...[]byte) {
	entry := Entry{VaultID: builder.vaultID, Seq: seq, PrevHash: prevHash, Type: entryType, Payload: payload}

	keys := make([]ed25519.PrivateKey, 0, len(signerSeeds))
	seeds := make([]string, 0, len(signerSeeds))

	for _, seed := range signerSeeds {
		keys = append(keys, ed25519.NewKeyFromSeed(seed))
		seeds = append(seeds, hex.EncodeToString(seed))
	}

	signed := must(entry.Sign(keys...))

	signatures := make([]string, 0, len(signed.Signatures))
	for _, signature := range signed.Signatures {
		signatures = append(signatures, hex.EncodeToString(signature))
	}

	builder.entries = append(builder.entries, entryJSON{
		Seq: seq, PrevHash: hex.EncodeToString(prevHash), Type: uint8(entryType), Payload: hex.EncodeToString(payload),
		SignerSeeds: seeds, Signatures: signatures, Hash: hex.EncodeToString(must(signed.Hash())),
	})
}

func decodeEntries(t *testing.T, vaultID string, entries []entryJSON) []Entry {
	t.Helper()

	out := make([]Entry, 0, len(entries))

	for _, entry := range entries {
		signatures := make([][]byte, 0, len(entry.Signatures))
		for _, signature := range entry.Signatures {
			signatures = append(signatures, unhex(t, signature))
		}

		out = append(out, Entry{
			VaultID: vaultID, Seq: entry.Seq, PrevHash: unhex(t, entry.PrevHash), Type: EntryType(entry.Type),
			Payload: unhex(t, entry.Payload), Signatures: signatures,
		})
	}

	return out
}

func decodeRotations(t *testing.T, rotations []escrowRotationJSON) []EscrowRotation {
	t.Helper()

	out := make([]EscrowRotation, 0, len(rotations))

	for _, rotation := range rotations {
		out = append(out, EscrowRotation{
			OldBundleHash: unhex(t, rotation.OldBundleHash),
			NewBundle:     must(ParseEscrowBundle(unhex(t, rotation.NewBundle))),
			Signature:     unhex(t, rotation.Signature),
		})
	}

	return out
}

func stateJSON(state LogState) logStateJSON {
	out := logStateJSON{Seq: state.Seq, Hash: hex.EncodeToString(state.Hash), Members: []memberJSON{}, Invitations: []invitationJSON{}}

	for _, userID := range slices.Sorted(maps.Keys(state.Members)) {
		member := state.Members[userID]
		out.Members = append(out.Members, memberJSON{UserID: userID, Role: uint8(member.Role), Fingerprint: hex.EncodeToString(member.Bundle.Fingerprint())})
	}

	for _, id := range slices.Sorted(maps.Keys(state.Invitations)) {
		invitation := state.Invitations[id]
		out.Invitations = append(out.Invitations, invitationJSON{
			ID: id, Role: uint8(invitation.Role), SignPub: hex.EncodeToString(invitation.SignPub), KEMPubHash: hex.EncodeToString(keyHash(invitation.KEMPub)),
		})
	}

	if state.Escrow != nil {
		out.Escrow = hex.EncodeToString(must(state.Escrow.Encode()))
	}

	if state.Converted {
		out.ConvertedAtSeq = &state.ConvertedAtSeq
	}

	return out
}

func recipientsJSON(recipients []EpochRecipient) []recipientJSON {
	out := make([]recipientJSON, 0, len(recipients))
	for _, recipient := range recipients {
		out = append(out, recipientJSON{Kind: recipient.Kind, ID: hex.EncodeToString(recipient.ID), KeyHash: hex.EncodeToString(recipient.KeyHash)})
	}

	return out
}

func decodeEpochRecord(t *testing.T, vaultID string, vector epochRecordJSON) EpochRecord {
	t.Helper()

	recipients := make([]EpochRecipient, 0, len(vector.Recipients))
	for _, recipient := range vector.Recipients {
		recipients = append(recipients, EpochRecipient{Kind: recipient.Kind, ID: unhex(t, recipient.ID), KeyHash: unhex(t, recipient.KeyHash)})
	}

	return EpochRecord{
		VaultID: vaultID, Epoch: vector.Epoch, Commitment: unhex(t, vector.Commitment), PrevCommitment: unhex(t, vector.PrevCommitment),
		LogSeq: vector.LogSeq, LogHash: unhex(t, vector.LogHash), Recipients: recipients, Signature: unhex(t, vector.Signature),
	}
}

func signedEpochRecordJSON(name string, record EpochRecord, signerSeed []byte) epochRecordJSON {
	signed := must(record.Sign(ed25519.NewKeyFromSeed(signerSeed)))

	return epochRecordJSON{
		Name: name, Epoch: record.Epoch, Commitment: hex.EncodeToString(record.Commitment), PrevCommitment: hex.EncodeToString(record.PrevCommitment),
		LogSeq: record.LogSeq, LogHash: hex.EncodeToString(record.LogHash), Recipients: recipientsJSON(record.Recipients),
		SignerSeed: hex.EncodeToString(signerSeed), Body: hex.EncodeToString(must(record.Body())), Signature: hex.EncodeToString(signed.Signature),
	}
}

// generateIdentityVectors builds the identity, log, epoch, anchor and escrow
// vectors from fixed inputs.
//
//nolint:funlen,maintidx // One flat list of vectors reads best in one place.
func generateIdentityVectors(t *testing.T) identityVectors {
	t.Helper()

	var vectors identityVectors

	alice := newVectorUser("alice", vectorAliceID)
	bob := newVectorUser("bob", vectorBobID)
	carol := newVectorUser("carol", vectorCarolID)

	for _, user := range []vectorUser{alice, bob, carol} {
		vectors.Identity = append(vectors.Identity, identityVector{
			Name:               user.id,
			UserID:             user.id,
			UserSecret:         hex.EncodeToString(user.secret.Bytes()),
			SignPub:            hex.EncodeToString(user.bundle.SignPub),
			KEMPub:             hex.EncodeToString(user.bundle.KEMPub),
			Bundle:             hex.EncodeToString(must(user.bundle.Encode())),
			Fingerprint:        hex.EncodeToString(user.bundle.Fingerprint()),
			FingerprintDisplay: FormatFingerprint(user.bundle.Fingerprint()),
			AnchorKey:          hex.EncodeToString(must(AnchorKey(user.secret.KEMSeed))),
		})
	}

	// Invitation signing keys.
	inviteSeeds := map[string][]byte{}
	invitePubs := map[string][]byte{}
	inviteSecrets := map[string][]byte{}
	invitationKeys := map[string][]byte{}

	for _, id := range []string{vectorInvitationOne, vectorInvitationTwo, vectorInvitationSix} {
		secret := fixed("invitation secret "+id, 16)
		seed := must(InviteSignSeed(secret, vectorVaultID, id))
		signPub, _ := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
		inviteSeeds[id], invitePubs[id] = seed, signPub
		inviteSecrets[id] = secret
		kemPrivateKey, kemPublicKey, err := InvitationKeyPair(secret, vectorVaultID, id)
		require.NoError(t, err)

		invitationKeys[id] = kemPublicKey
		vectors.InviteSign = append(vectors.InviteSign, inviteSignVector{
			Name: id, Secret: hex.EncodeToString(secret), VaultID: vectorVaultID, InvitationID: id,
			Seed: hex.EncodeToString(seed), SignPub: hex.EncodeToString(signPub),
		})
		vectors.InvitationKey = append(vectors.InvitationKey, invitationKeyVector{
			Name: id, Secret: hex.EncodeToString(secret), VaultID: vectorVaultID, InvitationID: id,
			PrivateKey: hex.EncodeToString(kemPrivateKey), PublicKey: hex.EncodeToString(kemPublicKey),
			AgeIdentity: must(AgeIdentity(kemPrivateKey)), AgeRecipient: must(AgeRecipient(kemPublicKey)),
		})
	}

	// Escrow bundles and their rotation chain.
	escrowOne, escrowOneSeed := newEscrowBundle("one")
	escrowTwo, escrowTwoSeed := newEscrowBundle("two")
	escrowThree, _ := newEscrowBundle("three")
	escrowThreeUnchained, escrowUnchainedSeed := newEscrowBundle("unchained")
	escrowFourReset, escrowResetSeed := newEscrowBundle("reset")

	for _, testCase := range []struct {
		name   string
		bundle EscrowBundle
		seed   []byte
	}{{"one", escrowOne, escrowOneSeed}, {"two", escrowTwo, escrowTwoSeed}, {"unchained", escrowThreeUnchained, escrowUnchainedSeed}, {"reset", escrowFourReset, escrowResetSeed}} {
		vectors.EscrowBundles = append(vectors.EscrowBundles, escrowBundleVector{
			Name: testCase.name, SignSeed: hex.EncodeToString(testCase.seed), SignPub: hex.EncodeToString(testCase.bundle.SignPub),
			Recipient: testCase.bundle.Recipient, Encoded: hex.EncodeToString(must(testCase.bundle.Encode())),
			Fingerprint:        hex.EncodeToString(must(testCase.bundle.Fingerprint())),
			FingerprintDisplay: FormatFingerprint(must(testCase.bundle.Fingerprint())),
		})
	}

	oneToTwo := must(SignEscrowRotation(ed25519.NewKeyFromSeed(escrowOneSeed), escrowOne, escrowTwo))
	twoToThree := must(SignEscrowRotation(ed25519.NewKeyFromSeed(escrowTwoSeed), escrowTwo, escrowThree))
	encodedOne := hex.EncodeToString(must(escrowOne.Encode()))

	vectors.EscrowChains = []escrowChainVector{
		{Name: "no rotation", Pinned: encodedOne, Rotations: []escrowRotationJSON{}, Result: encodedOne},
		{Name: "two rotations", Pinned: encodedOne, Rotations: []escrowRotationJSON{rotationJSON(oneToTwo), rotationJSON(twoToThree)}, Result: hex.EncodeToString(must(escrowThree.Encode()))},
	}

	unsigned := oneToTwo
	unsigned.Signature = must(SignEscrowRotation(ed25519.NewKeyFromSeed(escrowTwoSeed), escrowOne, escrowTwo)).Signature
	unchained := twoToThree
	misnamed := must(SignEscrowRotation(ed25519.NewKeyFromSeed(escrowOneSeed), escrowThree, escrowTwo))
	tampered := rotationJSON(oneToTwo)
	tampered.NewBundle = hex.EncodeToString(must(escrowThree.Encode()))

	vectors.RejectedEscrowChains = []escrowChainVector{
		{Name: "rotation signed by the new key", Pinned: encodedOne, Rotations: []escrowRotationJSON{rotationJSON(unsigned)}},
		{Name: "unchained escrow key: rotation from another bundle", Pinned: encodedOne, Rotations: []escrowRotationJSON{rotationJSON(unchained)}},
		{Name: "unchained escrow key: signed by the pinned key for another bundle", Pinned: encodedOne, Rotations: []escrowRotationJSON{rotationJSON(misnamed)}},
		{Name: "rotation with a swapped new bundle", Pinned: encodedOne, Rotations: []escrowRotationJSON{tampered}},
		{Name: "rotations out of order", Pinned: encodedOne, Rotations: []escrowRotationJSON{rotationJSON(twoToThree), rotationJSON(oneToTwo)}},
	}

	// The membership log, with every entry type but members (see the converted log below).
	builder := &logBuilder{vaultID: vectorVaultID}
	aliceSeed, bobSeed, carolSeed := alice.secret.SignSeed, bob.secret.SignSeed, carol.secret.SignSeed

	builder.add(EntryGenesis, must(GenesisPayload(alice.bundle, &escrowOne)), aliceSeed)                                                                            // 1
	builder.add(EntryInvite, must(InvitePayload(vectorInvitationOne, RoleEditor, invitePubs[vectorInvitationOne], invitationKeys[vectorInvitationOne])), aliceSeed) // 2
	builder.add(EntryRedeem, must(RedeemPayload(vectorInvitationOne, bob.bundle)), inviteSeeds[vectorInvitationOne], bobSeed)                                       // 3
	builder.add(EntrySetRole, must(SetRolePayload(vectorBobID, RoleOwner)), aliceSeed)                                                                              // 4
	builder.add(EntryInvite, must(InvitePayload(vectorInvitationTwo, RoleViewer, invitePubs[vectorInvitationTwo], invitationKeys[vectorInvitationTwo])), bobSeed)   // 5
	builder.add(EntryInvite, must(InvitePayload(vectorInvitationSix, RoleEditor, invitePubs[vectorInvitationSix], invitationKeys[vectorInvitationSix])), aliceSeed) // 6
	builder.add(EntryRevokeInvitation, must(IDPayload(vectorInvitationSix)), bobSeed)                                                                               // 7
	builder.add(EntryRedeem, must(RedeemPayload(vectorInvitationTwo, carol.bundle)), inviteSeeds[vectorInvitationTwo], carolSeed)
	builder.add(EntryEscrow, must(EscrowPayload(&escrowTwo)), aliceSeed) // 9
	builder.add(EntryRemoveMember, must(IDPayload(vectorCarolID)), aliceSeed)
	builder.add(EntryLeave, must(IDPayload(vectorBobID)), bobSeed)       // 11
	builder.add(EntryEscrow, must(EscrowPayload(nil)), aliceSeed)        // 12
	builder.add(EntryEscrow, must(EscrowPayload(&escrowTwo)), aliceSeed) // 13
	// Escrow resets: with escrow on, then with escrow off before turning it on.
	builder.add(EntryEscrowReset, must(EscrowResetPayload(escrowTwo, escrowThreeUnchained)), aliceSeed)       // 14
	builder.add(EntryEscrow, must(EscrowPayload(nil)), aliceSeed)                                             // 15
	builder.add(EntryEscrowReset, must(EscrowResetPayload(escrowThreeUnchained, escrowFourReset)), aliceSeed) // 16
	builder.add(EntryEscrow, must(EscrowPayload(&escrowFourReset)), aliceSeed)                                // 17

	rotations := []escrowRotationJSON{rotationJSON(oneToTwo), rotationJSON(twoToThree)}
	entries := decodeEntries(t, vectorVaultID, builder.entries)
	states, err := ReplayLog(vectorVaultID, entries, ReplayOptions{EscrowRotations: decodeRotations(t, rotations)})
	require.NoError(t, err)

	logVector := membershipLogVector{
		VaultID: vectorVaultID, EscrowRotations: rotations, Entries: builder.entries,
	}
	for _, state := range states {
		logVector.States = append(logVector.States, stateJSON(state))
	}

	recordAt := func(epoch, seq uint64, prevCommitment []byte) EpochRecord {
		state := states[seq-1]

		return EpochRecord{
			VaultID: vectorVaultID, Epoch: epoch, Commitment: must(KeyCommitment(fixed("log epoch key", KeySize), vectorVaultID, epoch)),
			PrevCommitment: prevCommitment, LogSeq: seq, LogHash: state.Hash, Recipients: must(EpochRecipients(state)),
		}
	}

	epochOne := recordAt(1, 1, make([]byte, MACSize))
	epochTwo := recordAt(2, 6, epochOne.Commitment)
	epochThree := recordAt(3, 10, epochTwo.Commitment)
	logVector.EpochRecords = []epochRecordJSON{
		signedEpochRecordJSON("epoch 1 at genesis", epochOne, aliceSeed),
		signedEpochRecordJSON("epoch 2 with members, invitations and escrow, signed by a second owner", epochTwo, bobSeed),
		signedEpochRecordJSON("epoch 3 after a removal", epochThree, aliceSeed),
	}
	vectors.MembershipLog = logVector

	// Epoch records that must be refused against that log.
	omitted := epochTwo
	omitted.Recipients = slices.Delete(slices.Clone(epochTwo.Recipients), 1, 2)
	reordered := epochTwo
	reordered.Recipients = slices.Clone(epochTwo.Recipients)
	reordered.Recipients[0], reordered.Recipients[1] = reordered.Recipients[1], reordered.Recipients[0]
	swappedKey := epochTwo
	swappedKey.Recipients = slices.Clone(epochTwo.Recipients)
	swappedKey.Recipients[0].KeyHash = keyHash(fixed("server key", PublicKeySize))
	swappedInvitationKey := epochTwo
	swappedInvitationKey.Recipients = slices.Clone(epochTwo.Recipients)
	swappedInvitationKey.Recipients[len(swappedInvitationKey.Recipients)-1].KeyHash = keyHash(fixed("server key", PublicKeySize))
	extra := epochThree
	extra.Recipients = slices.Clone(epochTwo.Recipients)
	wrongHash := epochTwo
	wrongHash.LogHash = states[4].Hash
	beyond := epochTwo
	beyond.LogSeq = uint64(len(states)) + 1
	nonZeroPrev := epochOne
	nonZeroPrev.PrevCommitment = epochTwo.Commitment
	otherVault := epochOne
	otherVault.VaultID = vectorOtherVaultID

	vectors.RejectedEpochRecords = []epochRecordJSON{
		signedEpochRecordJSON("omitted recipient", omitted, bobSeed),
		signedEpochRecordJSON("reordered recipients", reordered, bobSeed),
		signedEpochRecordJSON("recipient with another key", swappedKey, bobSeed),
		signedEpochRecordJSON("invitation recipient with another key than the log's", swappedInvitationKey, bobSeed),
		signedEpochRecordJSON("removed member still listed", extra, aliceSeed),
		signedEpochRecordJSON("wrong signer: an editor", recordAt(2, 3, epochOne.Commitment), bobSeed),
		signedEpochRecordJSON("wrong signer: an owner only later", recordAt(2, 2, epochOne.Commitment), bobSeed),
		signedEpochRecordJSON("wrong signer: a removed owner", recordAt(4, 12, epochThree.Commitment), bobSeed),
		signedEpochRecordJSON("log hash of another seq", wrongHash, bobSeed),
		signedEpochRecordJSON("log position beyond the log", beyond, bobSeed),
		signedEpochRecordJSON("epoch 1 with a previous commitment", nonZeroPrev, aliceSeed),
		signedEpochRecordJSON("record of another vault", otherVault, aliceSeed),
	}
	signatureFlipped := signedEpochRecordJSON("flipped signature bit", epochTwo, bobSeed)
	signatureFlipped.Signature = hex.EncodeToString(flip(must(hex.DecodeString(signatureFlipped.Signature)), 5))
	vectors.RejectedEpochRecords = append(vectors.RejectedEpochRecords, signatureFlipped)

	for index := range vectors.RejectedEpochRecords {
		vectors.RejectedEpochRecords[index].Body = ""
	}

	// Epoch positions against that log, whose only remove-member entry is seq 10.
	vectors.EpochPositions = []epochPositionsVector{
		{Name: "the log's epochs 1 to 3", LogSeqs: []uint64{1, 6, 10}},
		{Name: "two epochs at one position", LogSeqs: []uint64{1, 6, 6, 10}},
		{Name: "an epoch after the removal's", LogSeqs: []uint64{1, 6, 10, 13}},
		{Name: "no epoch yet", LogSeqs: []uint64{}},
	}
	vectors.RejectedEpochPositions = []epochPositionsVector{
		{Name: "epoch signed at a position before the previous epoch's", LogSeqs: []uint64{1, 6, 10, 9}},
		{Name: "positions going backwards before the removal", LogSeqs: []uint64{1, 6, 4, 10}},
		{Name: "current epoch before the last remove-member entry", LogSeqs: []uint64{1, 6}},
	}

	// Logs that must be refused.
	reject := func(name string, mutate func(entries []entryJSON) []entryJSON) {
		vectors.RejectedLogs = append(vectors.RejectedLogs, rejectedLogVector{
			Name: name, VaultID: vectorVaultID, EscrowRotations: rotations, Entries: mutate(slices.Clone(builder.entries)),
		})
	}
	rebuild := func(prefix int, entryType EntryType, payload []byte, signerSeeds ...[]byte) func([]entryJSON) []entryJSON {
		return func(entries []entryJSON) []entryJSON {
			rebuilt := &logBuilder{vaultID: vectorVaultID, entries: slices.Clone(entries[:prefix])}
			rebuilt.add(entryType, payload, signerSeeds...)

			return rebuilt.entries
		}
	}

	reject("broken link: prev hash changed", func(entries []entryJSON) []entryJSON {
		entries[4].PrevHash = entries[2].Hash

		return entries
	})
	reject("broken link: signed entry naming another prev hash", func(entries []entryJSON) []entryJSON {
		rebuilt := &logBuilder{vaultID: vectorVaultID, entries: slices.Clone(entries[:3])}
		rebuilt.addRaw(4, must(hex.DecodeString(entries[1].Hash)), EntrySetRole, must(SetRolePayload(vectorBobID, RoleOwner)), aliceSeed)

		return rebuilt.entries
	})
	reject("signed entry skipping a seq", func(entries []entryJSON) []entryJSON {
		rebuilt := &logBuilder{vaultID: vectorVaultID, entries: slices.Clone(entries[:3])}
		rebuilt.addRaw(5, must(hex.DecodeString(entries[2].Hash)), EntrySetRole, must(SetRolePayload(vectorBobID, RoleOwner)), aliceSeed)

		return rebuilt.entries
	})
	reject("omitted entry", func(entries []entryJSON) []entryJSON { return slices.Delete(entries, 3, 4) })
	reject("reordered entries", func(entries []entryJSON) []entryJSON {
		entries[4], entries[5] = entries[5], entries[4]

		return entries
	})
	reject("flipped payload bit", func(entries []entryJSON) []entryJSON {
		entries[1].Payload = hex.EncodeToString(flip(must(hex.DecodeString(entries[1].Payload)), 20))

		return entries
	})
	reject("wrong signer: invite by an editor", rebuild(3, EntryInvite, must(InvitePayload(vectorInvitationTwo, RoleViewer, invitePubs[vectorInvitationTwo], invitationKeys[vectorInvitationTwo])), bobSeed))
	reject("wrong signer: set role by the member itself", rebuild(3, EntrySetRole, must(SetRolePayload(vectorBobID, RoleOwner)), bobSeed))
	reject("wrong signer: genesis not by the creator", func([]entryJSON) []entryJSON {
		rebuilt := &logBuilder{vaultID: vectorVaultID}
		rebuilt.add(EntryGenesis, must(GenesisPayload(alice.bundle, &escrowOne)), bobSeed)

		return rebuilt.entries
	})
	reject("wrong signer: leave by an owner for another member", rebuild(10, EntryLeave, must(IDPayload(vectorBobID)), aliceSeed))
	reject("wrong signer: redeem without the invitation key", rebuild(2, EntryRedeem, must(RedeemPayload(vectorInvitationOne, bob.bundle)), bobSeed, bobSeed))
	reject("wrong signer: redeem without the newcomer", rebuild(2, EntryRedeem, must(RedeemPayload(vectorInvitationOne, bob.bundle)), inviteSeeds[vectorInvitationOne], carolSeed))
	reject("redeem with one signature", rebuild(2, EntryRedeem, must(RedeemPayload(vectorInvitationOne, bob.bundle)), inviteSeeds[vectorInvitationOne]))
	reject("redeem of a revoked invitation", rebuild(7, EntryRedeem, must(RedeemPayload(vectorInvitationSix, carol.bundle)), inviteSeeds[vectorInvitationSix], carolSeed))
	reject("unchained escrow key", rebuild(8, EntryEscrow, must(EscrowPayload(&EscrowBundle{SignPub: escrowTwo.SignPub, Recipient: escrowThree.Recipient})), aliceSeed))
	reject("unchained escrow key after escrow was off", rebuild(12, EntryEscrow, must(EscrowPayload(&escrowThreeUnchained)), aliceSeed))
	reject("escrow reset by a non-owner", rebuild(3, EntryEscrowReset, must(EscrowResetPayload(escrowOne, escrowThreeUnchained)), bobSeed))
	reject("escrow reset naming a bundle other than lastEscrow", rebuild(13, EntryEscrowReset, must(EscrowResetPayload(escrowOne, escrowThreeUnchained)), aliceSeed))
	reject("escrow reset to the same bundle", rebuild(13, EntryEscrowReset, must(EscrowResetPayload(escrowTwo, escrowTwo)), aliceSeed))
	reject("escrow reset in a log without escrow", func([]entryJSON) []entryJSON {
		rebuilt := &logBuilder{vaultID: vectorVaultID}
		rebuilt.add(EntryGenesis, must(GenesisPayload(alice.bundle, nil)), aliceSeed)
		rebuilt.add(EntryEscrowReset, must(EscrowResetPayload(escrowOne, escrowThreeUnchained)), aliceSeed)

		return rebuilt.entries
	})
	reject("escrow entry chained from the bundle before a reset", rebuild(14, EntryEscrow, must(EscrowPayload(&escrowThree)), aliceSeed))
	reject("escrow on after an off-state reset naming the bundle before it", rebuild(16, EntryEscrow, must(EscrowPayload(&escrowThreeUnchained)), aliceSeed))
	reject("invite without the invitation KEM key", rebuild(3, EntryInvite,
		slices.Concat(must(canonicalUUID(vectorInvitationTwo)), []byte{byte(RoleViewer)}, invitePubs[vectorInvitationTwo]), aliceSeed))
	reject("second genesis", rebuild(2, EntryGenesis, must(GenesisPayload(alice.bundle, nil)), aliceSeed))
	reject("removing the last owner", rebuild(1, EntryRemoveMember, must(IDPayload(vectorAliceID)), aliceSeed))
	reject("entry of another vault", func(entries []entryJSON) []entryJSON {
		other := &logBuilder{vaultID: vectorOtherVaultID, entries: slices.Clone(entries[:1])}
		other.add(EntryInvite, must(InvitePayload(vectorInvitationOne, RoleEditor, invitePubs[vectorInvitationOne], invitationKeys[vectorInvitationOne])), aliceSeed)

		return other.entries
	})

	unsignedRotationLog := rejectedLogVector{
		Name: "unsigned rotation", VaultID: vectorVaultID, EscrowRotations: []escrowRotationJSON{rotationJSON(unsigned)},
		Entries: slices.Clone(builder.entries[:9]),
	}
	vectors.RejectedLogs = append(vectors.RejectedLogs, unsignedRotationLog, rejectedLogVector{
		Name: "genesis that is not the trust anchor", VaultID: vectorVaultID, GenesisHash: hex.EncodeToString(fixed("other genesis", HashSize)),
		EscrowRotations: rotations, Entries: slices.Clone(builder.entries[:2]),
	})

	// The log of a converted vault: genesis, then a members entry with the
	// vault's last change sequence number before the conversion, naming the
	// members the vault already had.
	const convertedAtSeq = 41

	converted := &logBuilder{vaultID: vectorVaultID}
	convertedMembers := []Member{{Bundle: bob.bundle, Role: RoleEditor}, {Bundle: carol.bundle, Role: RoleViewer}}
	converted.add(EntryGenesis, must(GenesisPayload(alice.bundle, nil)), aliceSeed)
	converted.add(EntryMembers, must(MembersPayload(convertedAtSeq, convertedMembers)), aliceSeed)
	converted.add(EntrySetRole, must(SetRolePayload(vectorBobID, RoleOwner)), aliceSeed)

	convertedStates, err := ReplayLog(vectorVaultID, decodeEntries(t, vectorVaultID, converted.entries), ReplayOptions{})
	require.NoError(t, err)

	convertedVector := membershipLogVector{VaultID: vectorVaultID, EscrowRotations: []escrowRotationJSON{}, Entries: converted.entries}
	for _, state := range convertedStates {
		convertedVector.States = append(convertedVector.States, stateJSON(state))
	}

	convertedEpoch := EpochRecord{
		VaultID: vectorVaultID, Epoch: 1, Commitment: must(KeyCommitment(fixed("converted epoch key", KeySize), vectorVaultID, 1)),
		PrevCommitment: make([]byte, MACSize), LogSeq: 2, LogHash: convertedStates[1].Hash, Recipients: must(EpochRecipients(convertedStates[1])),
	}
	convertedVector.EpochRecords = []epochRecordJSON{signedEpochRecordJSON("epoch 1 of a converted vault at its members entry", convertedEpoch, aliceSeed)}
	vectors.ConvertedLog = convertedVector

	rejectConverted := func(name string, build func(log *logBuilder)) {
		log := &logBuilder{vaultID: vectorVaultID, entries: slices.Clone(converted.entries[:1])}
		build(log)
		vectors.RejectedLogs = append(vectors.RejectedLogs, rejectedLogVector{
			Name: name, VaultID: vectorVaultID, EscrowRotations: []escrowRotationJSON{}, Entries: log.entries,
		})
	}
	membersOf := func(members ...Member) []byte { return must(MembersPayload(convertedAtSeq, members)) }

	rejectConverted("members entry after another entry", func(log *logBuilder) {
		log.add(EntryInvite, must(InvitePayload(vectorInvitationOne, RoleEditor, invitePubs[vectorInvitationOne], invitationKeys[vectorInvitationOne])), aliceSeed)
		log.add(EntryMembers, membersOf(convertedMembers...), aliceSeed)
	})
	rejectConverted("members entry twice", func(log *logBuilder) {
		log.add(EntryMembers, membersOf(convertedMembers[0]), aliceSeed)
		log.add(EntryMembers, membersOf(convertedMembers[1]), aliceSeed)
	})
	rejectConverted("wrong signer: members entry signed by a listed member", func(log *logBuilder) {
		log.add(EntryMembers, membersOf(Member{Bundle: bob.bundle, Role: RoleOwner}), bobSeed)
	})
	rejectConverted("members entry listing the creator", func(log *logBuilder) {
		log.add(EntryMembers, membersOf(Member{Bundle: alice.bundle, Role: RoleOwner}, convertedMembers[0]), aliceSeed)
	})
	rejectConverted("members entry listing a user twice", func(log *logBuilder) {
		log.add(EntryMembers, membersOf(convertedMembers[0], Member{Bundle: bob.bundle, Role: RoleViewer}), aliceSeed)
	})
	rejectConverted("members entry with a count larger than its list", func(log *logBuilder) {
		payload := membersOf(convertedMembers...)
		payload[9]++
		log.add(EntryMembers, payload, aliceSeed)
	})
	rejectConverted("members entry without converted_at_seq", func(log *logBuilder) {
		log.add(EntryMembers, membersOf(convertedMembers...)[8:], aliceSeed)
	})
	rejectConverted("members entry with an unknown role", func(log *logBuilder) {
		payload := membersOf(convertedMembers...)
		payload[len(payload)-1] = 0x04
		log.add(EntryMembers, payload, aliceSeed)
	})

	// Invite anchor and anchor lists.
	genesisHash := must(hex.DecodeString(builder.entries[0].Hash))
	inviteSecret := inviteSecrets[vectorInvitationOne]
	anchor := must(MakeInviteAnchor(inviteSecret, vectorVaultID, vectorInvitationOne, InviteAnchor{
		GenesisHash: genesisHash, InviterFingerprint: alice.bundle.Fingerprint(),
	}))
	vectors.InviteAnchor = []inviteAnchorVector{{
		Name: "invitation one", Secret: hex.EncodeToString(inviteSecret), VaultID: vectorVaultID, InvitationID: vectorInvitationOne,
		GenesisHash: hex.EncodeToString(genesisHash), InviterFingerprint: hex.EncodeToString(alice.bundle.Fingerprint()),
		MACKey: hex.EncodeToString(must(InviteMACKey(inviteSecret, vectorVaultID, vectorInvitationOne))), Anchor: hex.EncodeToString(anchor),
	}}

	// A server that knows the invitation's public key forges an anchor
	// for another genesis; it cannot compute the MAC without the secret.
	forged := slices.Concat(fixed("forged genesis", HashSize), alice.bundle.Fingerprint(), anchor[HashSize+FingerprintSize:])
	rejectAnchor := func(name, secret, vaultID, invitationID string, encoded []byte) {
		vectors.RejectedInviteAnchors = append(vectors.RejectedInviteAnchors, inviteAnchorVector{
			Name: name, Secret: secret, VaultID: vaultID, InvitationID: invitationID, Anchor: hex.EncodeToString(encoded),
		})
	}
	secretHex := hex.EncodeToString(inviteSecret)
	rejectAnchor("other genesis hash with the original MAC", secretHex, vectorVaultID, vectorInvitationOne, forged)
	rejectAnchor("flipped fingerprint bit", secretHex, vectorVaultID, vectorInvitationOne, flip(anchor, HashSize+3))
	rejectAnchor("flipped MAC bit", secretHex, vectorVaultID, vectorInvitationOne, flip(anchor, InviteAnchorSize-1))
	rejectAnchor("other vault", secretHex, vectorOtherVaultID, vectorInvitationOne, anchor)
	rejectAnchor("other invitation", secretHex, vectorVaultID, vectorInvitationTwo, anchor)
	rejectAnchor("other secret", hex.EncodeToString(inviteSecrets[vectorInvitationTwo]), vectorVaultID, vectorInvitationOne, anchor)
	rejectAnchor("MAC truncated by one byte", secretHex, vectorVaultID, vectorInvitationOne, anchor[:InviteAnchorSize-1])
	rejectAnchor("trailing byte", secretHex, vectorVaultID, vectorInvitationOne, append(slices.Clone(anchor), 0))
	rejectAnchor("MAC under a key the server could derive: HMAC keyed by the invitation public key hash", secretHex, vectorVaultID, vectorInvitationOne,
		slices.Concat(fixed("forged genesis", HashSize), alice.bundle.Fingerprint(),
			must(inviteAnchorMAC(keyHash(invitationKeys[vectorInvitationOne]), vectorVaultID, vectorInvitationOne, fixed("forged genesis", HashSize), alice.bundle.Fingerprint()))))

	anchorKey := must(AnchorKey(alice.secret.KEMSeed))

	for _, testCase := range []struct {
		name    string
		version uint64
		anchors []Anchor
	}{
		{"empty", 1, nil},
		{"two vaults", 7, []Anchor{{VaultID: vectorVaultID, GenesisHash: genesisHash}, {VaultID: vectorOtherVaultID, GenesisHash: fixed("other genesis", HashSize)}}},
	} {
		nonce := fixed("anchor nonce "+testCase.name, NonceSize)
		anchors := []anchorJSON{}

		for _, anchor := range testCase.anchors {
			anchors = append(anchors, anchorJSON{VaultID: anchor.VaultID, GenesisHash: hex.EncodeToString(anchor.GenesisHash)})
		}

		vectors.AnchorList = append(vectors.AnchorList, anchorListVector{
			Name: testCase.name, AnchorKey: hex.EncodeToString(anchorKey), UserID: vectorAliceID, Version: testCase.version,
			Nonce: hex.EncodeToString(nonce), Anchors: anchors,
			Sealed: hex.EncodeToString(must(sealAnchorListWithNonce(anchorKey, nonce, vectorAliceID, testCase.version, testCase.anchors))),
		})
	}

	listed := vectors.AnchorList[1]
	vectors.RejectedAnchorLists = []rejectedAnchorListVector{
		{Name: "other version", AnchorKey: listed.AnchorKey, UserID: listed.UserID, Version: listed.Version - 1, Sealed: listed.Sealed},
		{Name: "other user", AnchorKey: listed.AnchorKey, UserID: vectorBobID, Version: listed.Version, Sealed: listed.Sealed},
		{Name: "other key", AnchorKey: hex.EncodeToString(must(AnchorKey(bob.secret.KEMSeed))), UserID: listed.UserID, Version: listed.Version, Sealed: listed.Sealed},
		{
			Name: "count larger than the list", AnchorKey: listed.AnchorKey, UserID: listed.UserID, Version: listed.Version,
			Sealed: hex.EncodeToString(must(sealWithNonce(anchorKey, fixed("anchor nonce bad", NonceSize),
				append([]byte{0, 0, 0, 3}, fixed("anchor bad", 48)...), must(anchorListAD(vectorAliceID, listed.Version))))),
		},
	}

	return vectors
}

func TestIdentityVectors(t *testing.T) {
	vectors := loadVectorFile(t).IdentityKeys

	t.Run("identity", func(t *testing.T) {
		for _, vector := range vectors.Identity {
			secret, err := ParseUserSecret(unhex(t, vector.UserSecret))
			require.NoError(t, err)
			bundle, err := secret.Bundle(vector.UserID)
			require.NoError(t, err)
			assert.Equal(t, vector.SignPub, hex.EncodeToString(bundle.SignPub))
			assert.Equal(t, vector.KEMPub, hex.EncodeToString(bundle.KEMPub))
			assert.Equal(t, vector.Bundle, hex.EncodeToString(must(bundle.Encode())))
			assert.Equal(t, vector.Fingerprint, hex.EncodeToString(bundle.Fingerprint()))
			assert.Equal(t, vector.FingerprintDisplay, FormatFingerprint(bundle.Fingerprint()))
			assert.Equal(t, vector.AnchorKey, hex.EncodeToString(must(AnchorKey(secret.KEMSeed))))

			parsed, err := ParseBundle(unhex(t, vector.Bundle))
			require.NoError(t, err)
			assert.Equal(t, bundle, parsed)
		}
	})

	t.Run("invite sign", func(t *testing.T) {
		for _, vector := range vectors.InviteSign {
			seed, err := InviteSignSeed(unhex(t, vector.Secret), vector.VaultID, vector.InvitationID)
			require.NoError(t, err)
			assert.Equal(t, vector.Seed, hex.EncodeToString(seed))
			assert.Equal(t, vector.SignPub, hex.EncodeToString(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)))
		}
	})

	t.Run("invitation key", func(t *testing.T) {
		require.Len(t, vectors.InvitationKey, 3)

		for _, vector := range vectors.InvitationKey {
			secret := unhex(t, vector.Secret)

			// The seed follows docs/design/crypto.md, derived here with HKDF
			// directly, not by the package.
			documented, err := hkdf.Key(sha256.New, secret, uuidBytes(t, vector.VaultID), "vault-sync/v1/invitation-key"+string(uuidBytes(t, vector.InvitationID)), 32)
			require.NoError(t, err)
			assert.Equal(t, vector.PrivateKey, hex.EncodeToString(documented))

			privateKey, publicKey, err := InvitationKeyPair(secret, vector.VaultID, vector.InvitationID)
			require.NoError(t, err)
			assert.Equal(t, vector.PrivateKey, hex.EncodeToString(privateKey))
			assert.Equal(t, vector.PublicKey, hex.EncodeToString(publicKey))
			assert.Equal(t, vector.AgeIdentity, must(AgeIdentity(privateKey)))
			assert.Equal(t, vector.AgeRecipient, must(AgeRecipient(publicKey)))
		}
	})

	t.Run("invite anchor", func(t *testing.T) {
		for _, vector := range vectors.InviteAnchor {
			secret := unhex(t, vector.Secret)
			assert.Equal(t, vector.MACKey, hex.EncodeToString(must(InviteMACKey(secret, vector.VaultID, vector.InvitationID))))

			made, err := MakeInviteAnchor(secret, vector.VaultID, vector.InvitationID, InviteAnchor{
				GenesisHash: unhex(t, vector.GenesisHash), InviterFingerprint: unhex(t, vector.InviterFingerprint),
			})
			require.NoError(t, err)
			assert.Equal(t, vector.Anchor, hex.EncodeToString(made))

			anchor, err := VerifyInviteAnchor(secret, vector.VaultID, vector.InvitationID, unhex(t, vector.Anchor))
			require.NoError(t, err)
			assert.Equal(t, vector.GenesisHash, hex.EncodeToString(anchor.GenesisHash))
			assert.Equal(t, vector.InviterFingerprint, hex.EncodeToString(anchor.InviterFingerprint))
		}

		for _, vector := range vectors.RejectedInviteAnchors {
			_, err := VerifyInviteAnchor(unhex(t, vector.Secret), vector.VaultID, vector.InvitationID, unhex(t, vector.Anchor))
			require.ErrorIs(t, err, ErrSignature, vector.Name)
		}
	})

	t.Run("anchor list", func(t *testing.T) {
		for _, vector := range vectors.AnchorList {
			anchors, err := OpenAnchorList(unhex(t, vector.AnchorKey), unhex(t, vector.Sealed), vector.UserID, vector.Version)
			require.NoError(t, err)

			got := []anchorJSON{}
			for _, anchor := range anchors {
				got = append(got, anchorJSON{VaultID: anchor.VaultID, GenesisHash: hex.EncodeToString(anchor.GenesisHash)})
			}

			assert.Equal(t, vector.Anchors, got)
		}

		for _, vector := range vectors.RejectedAnchorLists {
			_, err := OpenAnchorList(unhex(t, vector.AnchorKey), unhex(t, vector.Sealed), vector.UserID, vector.Version)
			require.ErrorIs(t, err, ErrDecrypt, vector.Name)
		}
	})

	t.Run("escrow", func(t *testing.T) {
		for _, vector := range vectors.EscrowBundles {
			signPub, _ := ed25519.NewKeyFromSeed(unhex(t, vector.SignSeed)).Public().(ed25519.PublicKey)
			bundle := EscrowBundle{SignPub: signPub, Recipient: vector.Recipient}
			assert.Equal(t, vector.Encoded, hex.EncodeToString(must(bundle.Encode())))
			assert.Equal(t, vector.Fingerprint, hex.EncodeToString(must(bundle.Fingerprint())), vector.Name)
			assert.Equal(t, vector.FingerprintDisplay, FormatFingerprint(must(bundle.Fingerprint())), vector.Name)
		}

		for _, vector := range vectors.EscrowChains {
			end, err := VerifyEscrowChain(must(ParseEscrowBundle(unhex(t, vector.Pinned))), decodeRotations(t, vector.Rotations))
			require.NoError(t, err, vector.Name)
			assert.Equal(t, vector.Result, hex.EncodeToString(must(end.Encode())))
		}

		for _, vector := range vectors.RejectedEscrowChains {
			_, err := VerifyEscrowChain(must(ParseEscrowBundle(unhex(t, vector.Pinned))), decodeRotations(t, vector.Rotations))
			require.ErrorIs(t, err, ErrSignature, vector.Name)
		}
	})

	replayVector := func(t *testing.T, logVector membershipLogVector) []LogState {
		t.Helper()

		entries := decodeEntries(t, logVector.VaultID, logVector.Entries)
		for index, entry := range entries {
			seeds := logVector.Entries[index].SignerSeeds

			keys := make([]ed25519.PrivateKey, 0, len(seeds))
			for _, seed := range seeds {
				keys = append(keys, ed25519.NewKeyFromSeed(unhex(t, seed)))
			}

			signed, err := entry.Sign(keys...)
			require.NoError(t, err)
			assert.Equal(t, entry.Signatures, signed.Signatures)
			assert.Equal(t, logVector.Entries[index].Hash, hex.EncodeToString(must(entry.Hash())))
		}

		genesis := sha256.Sum256(must(entries[0].Body()))
		states, err := ReplayLog(logVector.VaultID, entries, ReplayOptions{
			GenesisHash: genesis[:], EscrowRotations: decodeRotations(t, logVector.EscrowRotations),
		})
		require.NoError(t, err)

		got := make([]logStateJSON, 0, len(states))
		for _, state := range states {
			got = append(got, stateJSON(state))
		}

		assert.Equal(t, logVector.States, got)

		for _, vector := range logVector.EpochRecords {
			record := decodeEpochRecord(t, logVector.VaultID, vector)
			assert.Equal(t, vector.Body, hex.EncodeToString(must(record.Body())), vector.Name)
			signed := must(record.Sign(ed25519.NewKeyFromSeed(unhex(t, vector.SignerSeed))))
			assert.Equal(t, vector.Signature, hex.EncodeToString(signed.Signature), vector.Name)
			require.NoError(t, VerifyEpochRecord(logVector.VaultID, states, record), vector.Name)
		}

		return states
	}

	t.Run("membership log", func(t *testing.T) {
		logVector := vectors.MembershipLog
		states := replayVector(t, logVector)

		for _, vector := range vectors.RejectedEpochRecords {
			record := decodeEpochRecord(t, logVector.VaultID, vector)
			require.ErrorIs(t, VerifyEpochRecord(logVector.VaultID, states, record), ErrEpochRecord, vector.Name)
		}

		for _, vector := range vectors.EpochPositions {
			require.NoError(t, VerifyEpochPositions(states, vector.LogSeqs), vector.Name)
		}

		for _, vector := range vectors.RejectedEpochPositions {
			require.ErrorIs(t, VerifyEpochPositions(states, vector.LogSeqs), ErrEpochRecord, vector.Name)
		}
	})

	t.Run("converted log", func(t *testing.T) {
		replayVector(t, vectors.ConvertedLog)
	})

	t.Run("rejected logs", func(t *testing.T) {
		for _, vector := range vectors.RejectedLogs {
			options := ReplayOptions{EscrowRotations: decodeRotations(t, vector.EscrowRotations)}
			if vector.GenesisHash != "" {
				options.GenesisHash = unhex(t, vector.GenesisHash)
			}

			_, err := ReplayLog(vector.VaultID, decodeEntries(t, vector.VaultID, vector.Entries), options)
			require.ErrorIs(t, err, ErrLog, vector.Name)
		}
	})
}

// TestMembershipLogVectorStates pins the replayed states of the shared log by
// hand, independently of the replay that generated them.
func TestMembershipLogVectorStates(t *testing.T) {
	states := loadVectorFile(t).IdentityKeys.MembershipLog.States
	require.Len(t, states, 17)

	roles := func(state logStateJSON) map[string]uint8 {
		out := map[string]uint8{}
		for _, member := range state.Members {
			out[member.UserID] = member.Role
		}

		return out
	}
	pending := func(state logStateJSON) []string {
		out := []string{}
		for _, invitation := range state.Invitations {
			out = append(out, invitation.ID)
		}

		return out
	}

	owner, editor, viewer := uint8(RoleOwner), uint8(RoleEditor), uint8(RoleViewer)
	expected := []struct {
		roles   map[string]uint8
		pending []string
		escrow  string
	}{
		{map[string]uint8{vectorAliceID: owner}, []string{}, "one"},
		{map[string]uint8{vectorAliceID: owner}, []string{vectorInvitationOne}, "one"},
		{map[string]uint8{vectorAliceID: owner, vectorBobID: editor}, []string{}, "one"},
		{map[string]uint8{vectorAliceID: owner, vectorBobID: owner}, []string{}, "one"},
		{map[string]uint8{vectorAliceID: owner, vectorBobID: owner}, []string{vectorInvitationTwo}, "one"},
		{map[string]uint8{vectorAliceID: owner, vectorBobID: owner}, []string{vectorInvitationTwo, vectorInvitationSix}, "one"},
		{map[string]uint8{vectorAliceID: owner, vectorBobID: owner}, []string{vectorInvitationTwo}, "one"},
		{map[string]uint8{vectorAliceID: owner, vectorBobID: owner, vectorCarolID: viewer}, []string{}, "one"},
		{map[string]uint8{vectorAliceID: owner, vectorBobID: owner, vectorCarolID: viewer}, []string{}, "two"},
		{map[string]uint8{vectorAliceID: owner, vectorBobID: owner}, []string{}, "two"},
		{map[string]uint8{vectorAliceID: owner}, []string{}, "two"},
		{map[string]uint8{vectorAliceID: owner}, []string{}, ""},
		{map[string]uint8{vectorAliceID: owner}, []string{}, "two"},
		{map[string]uint8{vectorAliceID: owner}, []string{}, "unchained"},
		{map[string]uint8{vectorAliceID: owner}, []string{}, ""},
		{map[string]uint8{vectorAliceID: owner}, []string{}, ""},
		{map[string]uint8{vectorAliceID: owner}, []string{}, "reset"},
	}

	bundles := map[string]string{"": ""}
	for _, bundle := range loadVectorFile(t).IdentityKeys.EscrowBundles {
		bundles[bundle.Name] = bundle.Encoded
	}

	for index, want := range expected {
		state := states[index]
		assert.Equal(t, uint64(index+1), state.Seq)
		assert.Equal(t, want.roles, roles(state), "seq %d", index+1)
		assert.Equal(t, want.pending, pending(state), "seq %d", index+1)
		assert.Equal(t, bundles[want.escrow], state.Escrow, "seq %d", index+1)
	}
}

// TestConvertedLogVectorStates pins the replayed states of the converted
// vault's log and the users its epoch-1 record lists, by hand.
func TestConvertedLogVectorStates(t *testing.T) {
	log := loadVectorFile(t).IdentityKeys.ConvertedLog
	require.Len(t, log.States, 3)

	owner, editor, viewer := uint8(RoleOwner), uint8(RoleEditor), uint8(RoleViewer)
	expected := []map[string]uint8{
		{vectorAliceID: owner},
		{vectorAliceID: owner, vectorBobID: editor, vectorCarolID: viewer},
		{vectorAliceID: owner, vectorBobID: owner, vectorCarolID: viewer},
	}

	for index, want := range expected {
		roles := map[string]uint8{}
		for _, member := range log.States[index].Members {
			roles[member.UserID] = member.Role
		}

		assert.Equal(t, want, roles, "seq %d", index+1)
	}

	require.Len(t, log.EpochRecords, 1)
	record := log.EpochRecords[0]
	assert.Equal(t, uint64(2), record.LogSeq)

	listed := []string{}

	for _, recipient := range record.Recipients {
		assert.Equal(t, uint8(0x01), recipient.Kind)
		listed = append(listed, must(uuidString(unhex(t, recipient.ID))))
	}

	assert.ElementsMatch(t, []string{vectorAliceID, vectorBobID, vectorCarolID}, listed)
}
