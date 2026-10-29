# How encryption works

This page explains vault-sync's end-to-end encryption for users and operators: what it protects, what you have to keep safe, and how an operator recovers an encrypted vault. The design is `docs/design/encryption.md` and the byte formats are `docs/design/crypto.md`. Where this page and those documents disagree, they win.

End-to-end encryption is being built in Phase 4. Until the Phase 4 release, the server refuses to create an encrypted vault, and the plugin can only set up and unlock your encryption key (see [plugin.md](plugin.md#end-to-end-encryption)). This page describes encryption as it works once Phase 4 ships.

## In short

- Encryption is a choice per vault. A plaintext vault works as before.
- Your notes, attachments and file names are encrypted on your device before they are uploaded, and decrypted on your device after they are downloaded. The server stores and relays only ciphertext.
- You have one **recovery passphrase** for all your encrypted vaults. Enter it once on each device.
- If you lose your passphrase, your devices keep your files, but the server's copy can only be read again if the vault has **escrow** (see [Losing your passphrase](#losing-your-passphrase)).
- Escrow, on by default, lets the operator's backup job make plaintext backups of the vault. The vault's owner can turn it off when creating the vault.

## What the server can and can't see

The server, its PostgreSQL database and its S3 bucket hold only ciphertext for:

- the contents of every file (notes and attachments) and every earlier version kept in the history;
- every file and folder name and path;
- the vault's keys, your private key and your passphrase, which the server never receives in a form it can read.

The server can still see:

- that a vault exists, its name, whether it is encrypted and whether it has escrow;
- who the members are, their roles, their devices and their public keys;
- how many files the vault holds, their approximate sizes, when each one changes and from which device, and which revisions belong to the same file. Equal paths and equal contents produce equal keyed fingerprints, so the server can tell that two revisions are the same file or that two attachments have the same bytes, without learning the name or the bytes.

A path is encrypted as a whole, so the server does not see folder names or how files are grouped into folders either.

Merging concurrent edits, conflict copies, renames, deletes and history work exactly as in a plaintext vault. The merging happens on your devices, which decrypt, merge and encrypt again, so the server never needs the plaintext.

## Your key and your recovery passphrase

When you enable end-to-end encryption, your device creates your **key pair**. The public key is stored on the server so that others can share vault keys with you. The private key is stored on the server only after your device has wrapped (encrypted) it under a key derived from your recovery passphrase with Argon2id, a deliberately slow password hash (64 MiB of memory, 3 passes). The passphrase has at least 10 characters.

To unlock on a new device, you enter the passphrase. The device derives two keys from it: one that opens the wrapped private key and never leaves the device, and one that proves to the server you know the passphrase, so that the server hands over the wrapped key. Neither can be computed from the other, so the server cannot open your private key. Wrong passphrases are counted, and after 10 failures in an hour the server refuses every attempt until the hour is up, so someone who steals your login can only guess slowly. Even someone with a copy of the whole database still has to pay the full Argon2id cost for every guess, so choose a long passphrase that you don't use anywhere else.

Unlocking takes a few seconds on a phone and less on a desktop. You unlock once per device: the device then keeps your key in the plugin's own settings file (`data.json`), which vault-sync never syncs, until you sign out. One unlock opens every encrypted vault you belong to.

**Changing your passphrase** rewraps the same private key under the new passphrase. Devices that are already unlocked keep working; a new device needs the new passphrase.

## Vault keys

Each encrypted vault has its own random **vault key**. Contents and paths are encrypted with XChaCha20-Poly1305 under keys derived from it. The vault key is stored on the server once for every recipient, wrapped to that recipient's public key. Such a wrapped copy is a **key slot**. A vault's recipients are:

- every member;
- every pending invitation;
- the deployment's escrow key, if the vault has escrow.

Your device does all of the wrapping, including the escrow slot, so the server never holds a vault key it could open. Every vault key also has a **key commitment** stored with it, and a device checks each key it unwraps against it. That way a key slot that holds any other key, for example one that the server or a misbehaving member put there, is refused, and all members end up with the same key.

Every key wrapping is hybrid post-quantum: it combines X25519 with ML-KEM-768 (FIPS 203) in the standard age format, so it stays secret as long as either of the two holds. This protects recorded ciphertext against a future quantum computer. Key slots are ordinary age files, which is what makes [recovery with `age`](#recovery-with-age) possible.

## Creating an encrypted vault

You choose encryption when you create a vault; an existing vault can be converted later (see [Converting a plaintext vault](#converting-a-plaintext-vault)). The plugin offers escrow with the default the server is configured with, which is on unless the operator configured otherwise, and the owner can turn it off for the new vault. The plugin shows clearly whether a vault has escrow.

## Invitations

An invitation code to an encrypted vault looks like `<id>.<secret>`. The secret part is 128 random bits, and the invitation's own key pair is derived from it. The server sees only a hash of the `<id>` part and never the secret, so it cannot read the vault through an invitation.

When the invitation is created, the inviting device wraps every vault key the vault has ever had to the invitation, so the newcomer can read the whole vault, history included. When the newcomer redeems the code, their device derives the invitation's private key from the code, unwraps the vault keys, checks them against their commitments, and stores them again for its own key. No other member needs to be online for this. The invitation's key slots are then deleted, as they are when the invitation is revoked or expires, so an old code no longer gives access to the keys.

Send the code over a channel you trust: anyone who has it before it is redeemed, revoked or expired can join the vault.

## Rotation

A vault's key changes over time. Each key is an **epoch**, numbered from 1.

- **Removing a member** starts a new epoch at once, without the removed member. Everything committed afterwards is encrypted under a key they never get. What they could read before, they may already have copied, so the old epochs are not changed by the removal.
- **An owner can rotate by hand** at any time.

Other devices pick up a new epoch at their next sync. A device that tries to commit under an old epoch is told so, fetches the new key, encrypts again and retries, so its edit still lands. If two owner devices rotate at the same moment, exactly one new epoch is created and the other device adopts it. Devices keep every epoch key they have, so history stays readable.

## Re-encrypting history

After a rotation, older versions in the history are still encrypted under older keys. An owner's device re-encrypts them under the newest key in the background, in a job that resumes where it stopped. When no version uses an older key any more, the server retires that key: its key slots and the old ciphertext are deleted. Editing and syncing continue while the job runs, and it never changes which version of a file is current. If a rotation happens while it runs, or two owner devices run it at once, it still ends with every version on the newest key.

## Converting a plaintext vault

An owner can convert an existing plaintext vault to an encrypted one, keeping its history and members:

1. Every member must have set up end-to-end encryption. Otherwise the conversion is refused and the plugin lists the members who still have to.
2. The owner's device creates the first vault key and its key slots and switches the vault to encrypted in one step. From then on, the server refuses plaintext commits to the vault.
3. The existing history is then re-encrypted in the background, like after a rotation. Until that finishes, the server still holds the old plaintext versions.

Plaintext backups made before the conversion are not affected and remain plaintext.

## Escrow

Escrow adds one more recipient to a vault's keys: the deployment's **escrow key**, an age key pair. Its public key is published by the server; its private key, the escrow identity, is held only by the export job and never by the internet-facing server. Anyone who breaks into the server, PostgreSQL or S3 therefore still gets only ciphertext.

With escrow:

- the export job decrypts the vault and writes it in plaintext to the backup volume, like a plaintext vault (see [export.md](export.md)). A vault without escrow is skipped and listed as skipped in the export's summary;
- the operator can recover the vault if every member loses their passphrase;
- whoever holds the escrow identity can read the vault. That is the operator's backup job, and anyone who gets hold of its Secret or of an offline copy of it.

Without escrow, nobody but the members can ever read the vault, and nothing can recover it if every member loses their passphrase and every device.

**Turning escrow off** for an existing vault starts a new epoch without an escrow slot. Older epochs stay readable with the escrow key, so earlier versions remain recoverable; everything committed afterwards is not.

### For operators: the escrow key

Generate the escrow key with age 1.3 or later, on a machine you trust, and keep an offline copy of the identity:

```sh
age-keygen -pq -o escrow.key     # the identity: AGE-SECRET-KEY-PQ-1…
age-keygen -y escrow.key         # prints the public key: age1pq1…
```

Give the identity to the export job only, through the Secret that `config.export.escrow.secretName` names in the Helm chart (see [deployment.md](deployment.md)); the chart refuses to mount it into the server. The server publishes the public key and the escrow default to clients; [configuration.md](configuration.md) lists the variables. Treat the identity like the plaintext of every escrowed vault.

**Rotating the escrow key.** Configure the new public key, so that new epochs are wrapped to it, and give the export job both identities. The export job then re-wraps every existing escrow slot to the new key, checking each one against its key commitment first, including the slots of vaults deleted within the last 30 days. It repeats until no slot uses the old key, catching any slot that a device wrapped to the old key during the switch. Only then destroy the old identity, including its offline copies.

## Losing your passphrase

If you forget your recovery passphrase:

- **Your devices keep your files.** Every device that was unlocked keeps your key and your vault's files, and keeps syncing until you sign out. Don't sign out of your last unlocked device.
- **Without escrow**, the server's copy of every vault that no other member can open is lost for good. Nobody, including the operator, can decrypt it.
- **With escrow**, the operator can restore the vault: the export job writes its current files in plaintext (see [export.md](export.md)), and the operator gives you that copy, or imports it into an encrypted vault with the import tool, which encrypts with the vault's key unwrapped through the escrow identity.

Other members of a shared vault are not affected: they keep their own keys and passphrases.

## Recovery with `age`

An escrow key slot is a standard age file, so the operator can recover a vault key without any vault-sync software, for example from a database backup during disaster recovery. You need age 1.3 or later, the escrow identity, and read access to the PostgreSQL database (or a dump of it).

1. Find the vault's epochs. Each vault key is stored per epoch:

   ```sh
   psql "$DATABASE_URL" -At -c "SELECT epoch FROM vault_key_epochs WHERE vault_id = '0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e' ORDER BY epoch"
   ```

2. Extract the escrow slot of one epoch as a file:

   ```sh
   psql "$DATABASE_URL" -At -c "SELECT encode(wrapped_key, 'base64') FROM key_slots WHERE vault_id = '0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e' AND epoch = 1 AND recipient_kind = 'escrow'" | base64 -d > slot.age
   ```

   No row means that epoch has no escrow slot: the vault had escrow turned off by then, or never had it.

3. Decrypt the slot with the escrow identity. The first 32 bytes are the epoch's vault key:

   ```sh
   age --decrypt --identity escrow.key slot.age | head -c 32 > epoch-1.key
   ```

   The bytes after the first 32 name the vault, the epoch and the recipient the slot was made for (the `slot_ad` of `docs/design/crypto.md`), so you can check that you opened the slot you meant to.

The vault key decrypts the vault's contents and paths, in the formats `docs/design/crypto.md` defines. In normal operation you never do this by hand: the export job does the same with the identity it holds and writes the vault in plaintext. These steps show that an escrowed vault stays recoverable even without vault-sync; a test runs the `age` tool on an escrow slot to keep it that way.

## What vault-sync does not protect against

- **A compromised device.** A device holds your private key and your vaults' keys, and the plaintext files. Anyone who controls it can read them.
- **A member.** Every member can read the whole vault and keep copies. Removing a member protects only what is committed afterwards.
- **Metadata.** See [What the server can and can't see](#what-the-server-can-and-cant-see).
- **A server that swaps keys at creation.** The server distributes public keys. A malicious server could hand a device the wrong public key for a new member or for the escrow key; vault-sync does not yet let members compare key fingerprints with each other.
- **A lost single device.** There is no way to revoke one device's copy of your private key. An owner can rotate a vault's key instead, but a device that holds your private key can open the new key too as long as it can still sign in to the server.
