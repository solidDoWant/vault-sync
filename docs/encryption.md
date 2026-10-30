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
- how many files the vault holds, the exact size of every file and every version (encryption adds a fixed overhead and no padding), the length of every encrypted path, so roughly how long each path is, when each one changes and from which device, and which revisions belong to the same file. Equal paths and equal contents produce equal keyed fingerprints, so the server can tell that two revisions are the same file or that two attachments have the same bytes, without learning the name or the bytes.

A path is encrypted as a whole, so the server does not see folder names or how files are grouped into folders either.

Merging concurrent edits, conflict copies, renames, deletes and history work exactly as in a plaintext vault. The merging happens on your devices, which decrypt, merge and encrypt again, so the server never needs the plaintext.

## Your key and your recovery passphrase

When you enable end-to-end encryption, your device creates your **key pair**. The public key is stored on the server so that others can share vault keys with you. The private key is stored on the server only after your device has wrapped (encrypted) it under a key derived from your recovery passphrase with Argon2id, a deliberately slow password hash (64 MiB of memory, 3 passes). The passphrase has at least 10 characters.

To unlock on a new device, you enter the passphrase. The device derives two keys from it: one that opens the wrapped private key and never leaves the device, and one that proves to the server you know the passphrase, so that the server hands over the wrapped key. Neither can be computed from the other, so the server cannot open your private key. Wrong passphrases are counted, and after 10 failures in an hour the server refuses every attempt until the hour is up, so someone who steals your login can only guess slowly. Even someone with a copy of the whole database still has to pay the full Argon2id cost for every guess, so choose a long passphrase that you don't use anywhere else.

Unlocking takes a few seconds on a phone and less on a desktop. You unlock once per device: the device then keeps your private key, and the vault keys it opens, in Obsidian's local storage on that device, outside the vault folder and never in the plugin's `data.json` (which sits inside the vault folder), so no other sync or backup tool copies them, until you sign out. One unlock opens every encrypted vault you belong to.

**Changing your passphrase** rewraps the same private key under the new passphrase. Devices that are already unlocked keep working; a new device needs the new passphrase. Your key pair stays the same, so changing the passphrase does not lock out anyone who already knows the old one and holds an older copy of the database (a backup, for example): that copy still holds your private key wrapped under the old passphrase, and the old passphrase still opens it. If you think your passphrase leaked, changing it protects you only against the live server, not against old copies.

## Vault keys

Each encrypted vault has its own random **vault key**. Contents and paths are encrypted with XChaCha20-Poly1305 under keys derived from it. The vault key is stored on the server once for every recipient, wrapped to that recipient's public key. Such a wrapped copy is a **key slot**. A vault's recipients are:

- every member;
- every pending invitation;
- the deployment's escrow key, if the vault has escrow.

Your device does all of the wrapping, including the escrow slot, so the server never holds a vault key it could open. Every vault key also has a **key commitment** stored with it, and a device checks each key it unwraps against it, so a key slot that holds any other key, for example one that a misbehaving member put there, is refused. The commitment alone does not stop a server that replaces both an epoch's commitment and its key slots; what stops that is the owner's signature on every epoch, described in [Threat model](#threat-model).

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
- **Leaving a vault** does not start a new epoch by itself, because only an owner can sign one. The vault is marked as needing a rotation, and the new epoch is created when an owner's device next syncs. Until then, the member who left still holds the current key, and commits from the other members are still encrypted under it.
- **An owner can rotate by hand** at any time.

Other devices pick up a new epoch at their next sync. A device that tries to commit under an old epoch is told so, fetches the new key, encrypts again and retries, so its edit still lands. If two owner devices rotate at the same moment, exactly one new epoch is created and the other device adopts it. Devices keep every epoch key they have, so history stays readable.

## Re-encrypting history

After a rotation, older versions in the history are still encrypted under older keys. An owner's device re-encrypts them under the newest key in the background, in a job that resumes where it stopped. When no version uses an older key any more, the server retires that key: its key slots and the old ciphertext are deleted from the live database and bucket. They are not deleted from database backups or from older object versions the operator's S3 bucket keeps, so whoever holds such a copy and a retired key, or a slot it can open, can still read the old versions. Epoch 1 is never retired, because the file-name fingerprints are derived from its key for the vault's whole life; its content is still re-encrypted. Editing and syncing continue while the job runs, and it never changes which version of a file is current. If a rotation happens while it runs, or two owner devices run it at once, it still ends with every version on the newest key.

## Converting a plaintext vault

An owner can convert an existing plaintext vault to an encrypted one, keeping its history and members:

1. Every member must have set up end-to-end encryption. Otherwise the conversion is refused and the plugin lists the members who still have to.
2. The owner's device creates the first vault key and its key slots and switches the vault to encrypted in one step. From then on, the server refuses plaintext commits to the vault.
3. The existing history is then re-encrypted in the background, like after a rotation. Until that finishes, the server still holds the old plaintext versions.

Plaintext backups made before the conversion are not affected and remain plaintext.

## Escrow

Escrow adds one more recipient to a vault's keys: the deployment's **escrow key**, an age key pair. Its public key is published by the server; its private key, the escrow identity, is held only by the export job and never by the internet-facing server. Anyone who breaks into the server, PostgreSQL or S3 therefore gets no file contents, no paths and no vault key, but still sees the metadata listed in [What the server can and can't see](#what-the-server-can-and-cant-see).

A device does not simply trust whichever escrow key the server hands it. It pins the deployment's escrow key the first time it sees it and records it in the vault's membership log, and it accepts a different escrow key only with a rotation statement signed by the previous one, which the export job writes when the operator rotates the key. Any other change stops the device at vault creation and at rotation. The very first escrow key a device sees is taken on trust, so operators publish the escrow key's fingerprint, and an owner can compare it when creating a vault.

With escrow:

- the export job decrypts the vault and writes it in plaintext to the backup volume, like a plaintext vault (see [export.md](export.md)). A vault without escrow is skipped and listed as skipped in the export's summary;
- the operator can recover the vault if every member loses their passphrase;
- whoever holds the escrow identity can read the vault. That is the operator's backup job, and anyone who gets hold of its Secret or of an offline copy of it.

Without escrow, nobody but the members (and former members, for what they could read while they were members) can ever read the vault, and nothing can recover it if every member loses their passphrase and every device.

**Turning escrow off** for an existing vault starts a new epoch without an escrow slot. Older epochs stay readable with the escrow key for now, so earlier versions remain recoverable; everything committed afterwards is not. Over time escrow leaves the older versions too (see below).

### For operators: the escrow key

Generate the escrow key with age 1.3 or later, on a machine you trust, and keep an offline copy of the identity:

```sh
age-keygen -pq -o escrow.key     # the identity: AGE-SECRET-KEY-PQ-1…
age-keygen -y escrow.key         # prints the public key: age1pq1…
```

Give the identity to the export job only, through the Secret that `config.export.escrow.secretName` names in the Helm chart (see [deployment.md](deployment.md)), under the key `escrow.key`; the chart refuses to mount it into the server. Outside the chart, point the export's `VAULT_SYNC_ESCROW_IDENTITY_FILE` at the file. Give the public key to the server as `VAULT_SYNC_ESCROW_RECIPIENT` (`config.server.escrow.recipient` in the chart). The server publishes it and the escrow default (`VAULT_SYNC_ESCROW_DEFAULT`) to clients; [configuration.md](configuration.md) lists the variables. Treat the identity like the plaintext of every escrowed vault. Publish the escrow key's fingerprint to your users through a channel that does not depend on the server (your documentation or an announcement), so that owners can check that their devices pinned the real escrow key.

**Rotating the escrow key.** Run the export job's escrow rotation, `vault-sync-server export rotate-escrow`, with both identities and both escrow signing keys (step by step in [export.md](export.md#rotating-the-escrow-key)). It first appends the escrow rotation statement, signed by the old escrow signing key, so that devices accept the new key. It then re-wraps every existing escrow slot to the new key, checking each one against its key commitment first, including the slots of vaults deleted within the last 30 days; a slot that fails the check is reported and left in place. Then configure the server with the new key and list the old key as retiring, and re-run the rotation until it reports no slot on the old key, which catches any slot that a device wrapped to the old key during the switch. Only then destroy the old identity, including its offline copies.

**Turning escrow off leaves history over time.** When an owner turns escrow off, the older epochs keep their escrow slots. The re-key job later moves the revisions of those epochs to a newer epoch and retires them, so escrow eventually leaves the vault's content history. Epoch 1 is never retired, so its escrow slot stays: the escrow identity then still opens epoch 1's key, which no longer decrypts any content but still gives the file-name fingerprint secret. Until the re-key job is done, whoever holds the escrow identity can still read what was committed while escrow was on, and database backups and older S3 object versions keep that readable for as long as they are kept.

## Losing your passphrase

If you forget your recovery passphrase:

- **Your devices keep your files.** Every device that was unlocked keeps your key and your vault's files, and keeps syncing until you sign out. Don't sign out of your last unlocked device.
- **Without escrow**, the server's copy of every vault that no other member can open is lost for good. Nobody, including the operator, can decrypt it.
- **With escrow**, the operator can restore the vault: the export job writes its current files in plaintext (see [export.md](export.md)), and the operator gives you that copy, or imports it into an encrypted vault with the import tool, which encrypts with the vault's key unwrapped through the escrow identity. The import needs the vault fingerprint from a member, so that it can verify the vault's membership log instead of trusting the server.

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

## Threat model

This section says which attacks end-to-end encryption holds against and which it does not. It covers encrypted vaults only; a plaintext vault is protected by the server's access control alone.

### A stolen copy of the database or the bucket

Someone who gets a copy of the PostgreSQL database or the S3 bucket, from a backup, a leaked dump or a break-in, gets the ciphertext of every file and path, the wrapped key slots, every user's private key wrapped under their passphrase, and the metadata listed in [What the server can and can't see](#what-the-server-can-and-cant-see). Without a member's passphrase or the escrow identity, they cannot read any file or path. Every guess at a passphrase costs them a full Argon2id computation, with no server to slow them down further, so a weak passphrase can be guessed offline; a long one that you use nowhere else cannot.

Old copies keep what they held when they were made: a backup made before a passphrase change still opens with the old passphrase, and a backup made before a key was retired still holds that key's slots and ciphertext.

### An actively malicious server

End-to-end encryption also holds against a server that is actively malicious while you use it, or an attacker who controls the running server. Such a server cannot obtain a vault key: not by adding its own public key to a vault, not by swapping a member's or the escrow key for its own, not by injecting a vault key of its own choosing, and not by rolling a vault back to an older key.

This holds because devices never take the server's word for who is in a vault or which key is current:

- Each user has a signing key next to their encryption key. Together they form the user's key, whose **fingerprint** the plugin shows in the member list.
- Each encrypted vault has a **membership log**: an append-only chain of entries, each signed by the member allowed to make that change (an owner for invitations, removals, role and escrow changes; the newcomer and the invitation for joining; the leaving member for leaving). A device replays the whole log, checking every link and signature, and takes the member list and every member's key only from it.
- Every vault key (epoch) is signed by an owner and names its exact recipients. A device uses a vault key only from an epoch signed this way, wraps keys only to recipients from the verified log, and refuses an older epoch than the newest it has verified, and a shorter or rewritten log than it has already seen.
- A device knows which log is the real one because it created the vault, because the invitation code vouches for it (the server never sees the code's secret part), or, for your other devices, from your own list of vaults, sealed under your private key and versioned so that the server cannot roll it back.
- The escrow key is pinned and changes only with a statement signed by the previous escrow key (see [Escrow](#escrow)).

When any of this fails to verify, the plugin stops syncing that vault, keeps your local files, and reports that the server sent key or membership data that doesn't verify. It never falls back to trusting the server.

Two moments still rely on trust, as any first meeting does:

- **Converting a plaintext vault.** The converting owner's device writes the first log entry with every member's key as the server reports it at that moment. The plugin therefore shows every member's fingerprint and asks the owner to compare them with the members, for example in person or over a channel you already trust, before converting.
- **The first escrow key.** A device pins the escrow key the server shows it first. Operators publish the escrow key's fingerprint so that owners can compare it when creating a vault.

Members can compare their fingerprints in the member list at any time. A fingerprint that differs from what its owner sees on their own device means someone's key was swapped.

### What encryption does not protect

- **Metadata.** The server sees everything listed in [What the server can and can't see](#what-the-server-can-and-cant-see), including exact file sizes, path lengths, timing and devices.
- **Withheld, delayed or replayed changes.** A malicious server can hold back changes, deliver them late, show an older state of a file, or stop serving a vault altogether. Devices detect a rollback of the keys and the membership log, not whether the files they receive are the newest ones.
- **Authorship.** Encryption does not prove which member wrote a revision. Every holder of a vault key can encrypt under it, and the device and member a revision is shown as coming from are what the server reports.
- **A compromised device.** A device holds your private key and your vaults' keys, and the plaintext files. Anyone who controls it can read them.
- **A member.** Every member can read the whole vault and keep copies. Removing a member protects only what is committed afterwards, and a member who leaves keeps the current key until an owner's device next syncs and rotates (see [Rotation](#rotation)).
- **File-name guesses by a removed member.** The secret behind the server's file-name fingerprints comes from the vault's first key and never changes, so a removed member keeps it. With a later copy of the database, they can test whether a file with a name they guess exists, though they cannot read the names that exist.
- **Old copies.** Database backups and older S3 object versions keep retired keys' slots and ciphertext, and your private key wrapped under any earlier passphrase. Whoever holds both such a copy and an old passphrase, a retired key, or the escrow identity of the time can read what that copy holds.
- **A lost single device.** There is no way to revoke one device's copy of your private key. An owner can rotate a vault's key instead, but a device that holds your private key can open the new key too as long as it can still sign in to the server.
