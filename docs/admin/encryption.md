# Encryption for operators

For: admins. You run the server with the Helm chart, and you know PostgreSQL, S3 and Kubernetes Secrets. You do not need to know how the ciphers work.

This page tells you what the server holds for an end-to-end encrypted vault, and what it cannot read. It also tells you how to set up the escrow key, how to rotate it, and how to recover a vault when a member loses their passphrase. Users read [End-to-end encryption](../user/encryption.md). Developers read [the encryption design](../design/encryption.md), [the byte formats](../design/crypto.md) and `SPEC.md` §9.3 and §9.4. Where this page and those documents disagree, they win.

Encrypted vaults cannot sync yet. This page describes encryption as it works once sync of encrypted vaults is ready.

## In short

- Encryption is a choice for each vault. A plaintext vault works as before.
- In an encrypted vault, the devices encrypt the contents and the paths of files before upload. The server, PostgreSQL and S3 hold only ciphertext.
- Each user has one recovery passphrase for all their encrypted vaults. The server never receives it in a form that it can read.
- Escrow lets your export job make plaintext backups of an encrypted vault. With escrow, you can also recover the vault if every member loses their passphrase. Escrow is on by default for a new vault, and the owner can turn it off.
- You hold the escrow key. Treat it like the plaintext of every vault that has escrow.

## What the server can and cannot see

The server, its PostgreSQL database and its S3 bucket hold only ciphertext for:

- The contents of every file (notes and attachments), and every earlier version in the history.
- Every file and folder name and path.
- The keys of the vault, the private key of each user, and each passphrase. The server never receives them in a form that it can read.

The server can still see:

- That a vault exists, its name, whether it is encrypted and whether it has escrow.
- Who the members are, their roles, their devices and their public keys.
- How many files the vault holds, and the exact size of every file and every version. Encryption adds a fixed overhead and no padding.
- The length of every encrypted path, so about how long each path is.
- When each file changes, from which device, and which revisions belong to the same file.

Equal paths and equal contents produce equal keyed fingerprints. So the server can tell that two revisions are the same file, or that two attachments have the same bytes. It does not learn the name or the bytes. The device encrypts a path as a whole, so the server does not see folder names, or how files are grouped into folders.

Merges, conflict copies, renames, deletes and history work as in a plaintext vault. The devices decrypt, merge and encrypt again, so the server never needs the plaintext.

## The recovery passphrase and the guess limit

The device of a user creates the user's key pair. The server stores the private key only after the device wrapped (encrypted) it under a key from the recovery passphrase. A deliberately slow password hash, Argon2id, stretches the passphrase into that key. Even someone with a copy of the whole database must pay the full Argon2id cost for every guess. A weak passphrase can be guessed offline, but a long one cannot.

To unlock a new device, the device proves to the server that the user knows the passphrase. The server counts wrong passphrases for each user. After 10 failures in an hour, the server refuses every attempt until the hour is over, also with the right passphrase. So someone who steals a login can only guess slowly.

Escrow is the only way to recover a vault without the passphrase of a member. [`docs/design/crypto.md`](../design/crypto.md) has the Argon2id parameters and the key chain.

## Vault keys and key slots

Each encrypted vault has its own random vault key. The devices encrypt contents and paths under keys derived from it. The server stores the vault key once for every recipient, wrapped to the public key of that recipient. A wrapped copy is a key slot. The recipients of a vault are:

- Every member.
- Every pending invitation.
- The escrow key of the deployment, if the vault has escrow.

The devices do all of the wrapping, also of the escrow slot. So the server never holds a vault key that it can open.

The server stores a key commitment with every vault key. A device compares each key that it unwraps with the commitment, and refuses a key slot that holds any other key. The commitment alone does not stop a server that replaces both the commitment and the key slots. The signature of an owner on every epoch stops that (see [An actively malicious server](security.md#an-actively-malicious-server)).

Every key wrapping is hybrid post-quantum, in the standard age format. It stays secret as long as one of its two parts holds. This protects recorded ciphertext against a future quantum computer. A key slot is an ordinary age file, so you can open an escrow slot with the `age` tool (see [Recovery with age](#recovery-with-age)). [`docs/design/crypto.md`](../design/crypto.md) names the ciphers.

## The escrow default for new vaults

When an owner creates an encrypted vault, the plugin offers escrow. The default of the escrow toggle comes from the server, from `VAULT_SYNC_ESCROW_DEFAULT` (`config.server.escrow.default` in the chart). It is `true` unless you change it. The owner can turn escrow off for the new vault. The plugin shows whether a vault has escrow. If the server has no escrow key (`VAULT_SYNC_ESCROW_RECIPIENT` is unset), the server publishes the default as `false`, and creating a vault with escrow fails. The variables are in the [configuration reference](configuration-reference.md#escrow).

## Epochs and key rotation

The key of a vault changes over time. Each key is an epoch, numbered from 1.

- Removing a member starts a new epoch at once, without the removed member. Everything committed afterwards is encrypted under a key that they never get. The old epochs do not change, because the removed member already could read them.
- Leaving a vault does not start a new epoch by itself, because only an owner can sign one. The server marks the vault as needing a rotation. An owner's device creates the new epoch at its next sync. Until then, the member who left still holds the current key, and the other members still commit under it.
- An owner can rotate by hand at any time, with **Rotate key** in the plugin. The device wraps the new epoch for every current member, every pending invitation, and the escrow key if the vault has escrow.

In a vault with escrow, the owner's device refuses to rotate when the server does not have the escrow key that the device pinned. After you rotate the escrow key, the next rotation by an owner also moves the vault to the new escrow key and wraps the new epoch to it. The escrow rotation statement authorizes that move. Removing a member from such a vault does that rotation first, so it creates two new epochs.

Other devices get a new epoch at their next sync. A device that commits under an old epoch gets an error. It fetches the new key, encrypts again and retries, so its edit still lands. If two owner devices rotate at the same moment, the server creates exactly one new epoch, and the other device uses it. Devices keep every epoch key that they have, so the history stays readable.

## Re-encrypting history

After a rotation, older versions in the history are still encrypted under older keys. An owner's device encrypts them again under the newest key, in the background. The job continues where it stopped. Editing and sync continue while it runs, and it never changes which version of a file is current. If a rotation happens while it runs, or two owner devices run it at once, it still ends with every version on the newest key.

When no version uses an older key any more, the server retires that key. It deletes the key slots and the old ciphertext from the live database and bucket. They stay in database backups, and in older object versions that your S3 bucket keeps. Whoever holds such a copy and a retired key, or a slot that they can open, can still read the old versions.

The server never retires epoch 1, because the file-name fingerprints come from its key for the whole life of the vault. The job still encrypts the content of epoch 1 again.

If the backlog of old versions does not shrink for a day, the [VaultSyncRekeyBacklogNotShrinking](alerts.md#vaultsyncrekeybacklognotshrinking) alert fires. Its runbook tells you what to do.

## Escrow

Escrow adds one more recipient to the keys of a vault: the escrow key of the deployment. The escrow key is an age key pair. The server publishes its public key. Its private key, the escrow identity, is held only by the export job, never by the server. So someone who breaks into the server, PostgreSQL or S3 gets no file contents, no paths and no vault key. They still see the metadata in [What the server can and cannot see](#what-the-server-can-and-cannot-see).

With escrow:

- The export job decrypts the vault and writes it in plaintext to the backup volume, as for a plaintext vault. The export skips a vault without escrow, and lists it as skipped in its summary. See [Backup and restore](backup-and-restore.md).
- You can recover the vault if every member loses their passphrase.
- Whoever holds the escrow identity can read the vault. That is your export job, and anyone who gets its Secret or an offline copy of it.

Without escrow, only the members can read the vault, and former members what they could read while they were members. Nothing can recover the vault if every member loses their passphrase and every device.

A device does not trust any escrow key that the server shows it. It pins the escrow key the first time that it sees it, and records it in the membership log of the vault. It accepts a different escrow key only with a rotation statement signed by the previous key. The rotation (see [Rotate the escrow key](#rotate-the-escrow-key)) writes that statement. Any other change stops the device when it creates a vault and when it rotates. A device takes the first escrow key that it sees on trust. So you publish the escrow fingerprint, and owners compare it when they create a vault.

### Turning escrow off

When an owner turns escrow off for a vault, the device starts a new epoch without an escrow slot. Everything committed afterwards is not readable with the escrow key. The older epochs keep their escrow slots, so earlier versions stay recoverable for now.

The re-key job later moves the revisions of those epochs to a newer epoch and retires the old epochs. So escrow leaves the content history over time. Epoch 1 is never retired, so its escrow slot stays. The escrow identity then still opens the key of epoch 1. That key decrypts no content any more, but it still gives the secret of the file-name fingerprints.

Until the re-key job is done, whoever holds the escrow identity can still read what was committed while escrow was on. Database backups and older S3 object versions keep it readable for as long as you keep them.

## The escrow key

### Generate and install the escrow key

Generate the escrow key with age 1.3 or later, on a machine that you trust. Keep an offline copy of the identity:

```sh
age-keygen -pq -o escrow.key     # the identity: AGE-SECRET-KEY-PQ-1…
age-keygen -y escrow.key         # prints the public key: age1pq1…
```

The server also needs an escrow signing key, an Ed25519 key pair. Generate it on the same machine with the `openssl` commands in step 1 of [The order of steps](#the-order-of-steps). Keep its private key offline (see [Keep the escrow signing key offline](#keep-the-escrow-signing-key-offline)).

Then give each key to the right component:

1. Give the identity to the export job only. Put it in the Secret that `config.export.escrow.secretName` names, under the key `escrow.key` (see [Chart values](chart-values.md)). The chart refuses to mount it into the server. Outside the chart, set `VAULT_SYNC_ESCROW_IDENTITY_FILE` of the export to the path of the file.
2. Give the public key to the server as `VAULT_SYNC_ESCROW_RECIPIENT` (`config.server.escrow.recipient` in the chart).
3. Give the signing public key to the server as `VAULT_SYNC_ESCROW_SIGNING_KEY` (`config.server.escrow.signingKey` in the chart).

The server publishes the escrow key and the escrow default (`VAULT_SYNC_ESCROW_DEFAULT`) to the clients. The variables are in the [configuration reference](configuration-reference.md#escrow). Treat the identity like the plaintext of every vault that has escrow.

### Publish the escrow fingerprint

The escrow fingerprint is a short value that identifies the escrow key and the escrow signing key together. The plugin shows it next to the escrow toggle when an owner creates a vault, and in the fingerprints of a vault with escrow. Owners compare it with the value that you publish. Then they know that their devices use your real escrow key.

To print it, run this command on any host with the `vault-sync-server` binary:

```sh
vault-sync-server escrow fingerprint --recipient age1pq1… --signing-key BASE64
```

`--recipient` is the public key of the escrow key (`age1pq1…`). `--signing-key` is the escrow signing public key in standard base64, the value of `VAULT_SYNC_ESCROW_SIGNING_KEY`. If you do not give the flags, the command reads `VAULT_SYNC_ESCROW_RECIPIENT` and `VAULT_SYNC_ESCROW_SIGNING_KEY`. The command does not need the database, the network or a private key.

The command prints the fingerprint on one line, in eight groups of four characters, for example `7Z1Z Z8ND Z01N DEDJ AYZY KQZ8 R7YY 9X99`. If a value is not valid, the command prints an error and exits with code 1. The error does not repeat the value.

Publish the fingerprint through a channel that does not depend on the server, for example your documentation or an announcement. After you rotate the escrow key, publish the fingerprint of the new pair.

## Rotate the escrow key

`vault-sync-server export rotate-escrow` moves every escrow slot to a new escrow key. You run it by hand, and you name the new escrow bundle: its age recipient and its Ed25519 signing public key. The escrow chain in PostgreSQL records each escrow bundle and the statements that link them. For the mechanism, see *Escrow* in [the encryption design](../design/encryption.md#escrow).

### Keep the escrow signing key offline

The escrow signing key is the private key that signs the move from one escrow key to the next. Devices trust a new escrow key only when the old signing key signed it. This protects devices only if the signing key is never on the cluster. So:

- Keep the signing key file on an offline machine or medium, with a second offline backup.
- Bring it out only for a rotation, and put it away again after the rotation.
- Do not put it in a Kubernetes Secret that a pod mounts. The Helm chart has no value for it. The chart refuses to render if a controller gets `VAULT_SYNC_ESCROW_SIGNING_KEY_FILE` or runs `export rotate-escrow`.

A rotation is a rare manual task. You run it from your own machine or as a one-off pod (see [Run the rotation](#run-the-rotation)).

### The rotate-escrow command

```sh
vault-sync-server export rotate-escrow -server https://sync.example.com \
  -recipient age1pq1… -signing-public-key BASE64
```

| Flag | Description |
|---|---|
| `-server URL` | Required. The server's URL. The rotation writes only through its job-only `EscrowJobService`. |
| `-recipient` | Required. The new escrow key's age recipient (`age1pq1…`, from `age-keygen -y`). |
| `-signing-public-key` | Required. The new escrow signing public key: standard base64 of the 32-byte Ed25519 public key. |

It reads `VAULT_SYNC_DATABASE_URL` and the database TLS variables (read-only, as the export does), `VAULT_SYNC_LOG_LEVEL`, and three files. All three are required:

| Variable | Description |
|---|---|
| `VAULT_SYNC_ESCROW_IDENTITY_FILE` | The escrow identities: the new one and every old one whose slots are still to be moved. |
| `VAULT_SYNC_ESCROW_SIGNING_KEY_FILE` | The escrow signing keys, one standard base64 Ed25519 seed (32 bytes) per line, blank lines and `#` comments ignored. Keys are matched to bundles by their public keys, not by line order. It must hold the new bundle's key and the key of the escrow chain's current head. |
| `VAULT_SYNC_ESCROW_JOB_TOKEN_FILE` | The job token that the server checks on `EscrowJobService` (see the [configuration reference](configuration-reference.md#escrow)). |

[Which variables each command reads](configuration.md#which-variables-each-command-reads) lists the variables of every command. A run does this:

1. It refuses to start unless the identity file holds the new identity, and the signing key file holds the new signing key and the key of the chain head. It reads the escrow chain from PostgreSQL and makes sure that it is valid.
2. If the head of the chain is not the new bundle yet, it appends the escrow rotation statement to the chain, signed by the signing key of the head. A repeat run finds the new bundle at the head and appends nothing.
3. It goes through every vault, also deleted vaults that are not purged yet (deleted within the last 30 days). It opens every escrow slot that is not on the new key with its identity, and compares the key with the key commitment of its epoch. Then it wraps the key to the new escrow key and replaces the slot, only if the old slot is still there. It reports a slot that does not open, has no identity in the file or fails its commitment, and leaves it in place.
4. It counts the escrow slots still not on the new key. This catches a slot that a device wrapped to the old key during the run.

It prints one JSON line. It exits `0` only when no slot failed and no slot is left on an old key. Otherwise it exits `1`, and `2` for invalid flags. Logs and the summary never hold keys or note content.

```json
{"status": "ok", "target_key_id": "sha256:…", "appended_statement": true, "vaults": 12,
 "rewrapped": 340, "old_key_slots": 0, "failed_slots": 0, "failures": []}
```

`failures` lists up to 100 of the `failed_slots`, each with `vault_id`, `epoch`, `recipient_id` and `reason`.

### The order of steps

1. On your offline machine, generate the new escrow key and a new escrow signing key. Add the new identity to the identity file and the new seed to the signing key file. Keep the old ones in both files:

   ```sh
   age-keygen -pq -o new-escrow.key && age-keygen -y new-escrow.key              # -recipient
   openssl genpkey -algorithm ed25519 -out new-signing.pem
   openssl pkey -in new-signing.pem -outform DER | tail -c 32 | base64           # the seed, for the signing key file
   openssl pkey -in new-signing.pem -pubout -outform DER | tail -c 32 | base64   # -signing-public-key
   ```

2. Run `export rotate-escrow` with the new bundle, as in [Run the rotation](#run-the-rotation). It appends the rotation statement and re-wraps the existing slots.
3. Update the server. Set `VAULT_SYNC_ESCROW_RECIPIENT` and `VAULT_SYNC_ESCROW_SIGNING_KEY` to the new bundle. The server refuses to start with a bundle that is not the head of the chain. Put the id of the old key in `VAULT_SYNC_ESCROW_RETIRING_KEY_IDS`. Then the server accepts slots that devices still wrap to the old key during the switch.
4. Run `export rotate-escrow` again until it reports `"old_key_slots": 0` and exits `0`. Look into any slot listed in `failures`: it stays on the old key.
5. Unset `VAULT_SYNC_ESCROW_RETIRING_KEY_IDS`. Then remove the old identity and the old seed from the files and destroy them, offline copies included.
6. Put the signing key file with the new seed back into offline storage, and update its offline backup. Delete every copy that is not offline.
7. Publish the fingerprint of the new pair (see [Publish the escrow fingerprint](#publish-the-escrow-fingerprint)).

An escrow slot now opens with the new identity and `age --decrypt` (see [Recovery with age](#recovery-with-age)). The [VaultSyncEscrowRewrapStuck](alerts.md#vaultsyncescrowrewrapstuck) alert fires when slots stay on a retiring key for two days.

### Run the rotation

Both ways need the same inputs:

- The database URL of a role that can read the vault-sync database, as for the export.
- The server's public URL.
- The escrow job token, from the Secret that `config.escrowJobToken.secretName` names.
- From offline storage: the identity file (`escrow.key`) and the signing key file (`signing.keys`).

The examples use the namespace `vault-sync`, the token Secret `vault-sync-escrow-job-token`, the image version `VERSION`, and the new bundle in `$RECIPIENT` and `$SIGNING_PUBLIC_KEY`. Change them for your installation.

If your database needs TLS client certificates, add them to the run as the `VAULT_SYNC_DATABASE_TLS_*` files (see the [configuration reference](configuration-reference.md#postgresql-connection)). For the one-off pod, put them in the temporary Secret too.

#### From your own machine

You need the `vault-sync-server` binary of the same version as the server, and `kubectl` access to the namespace of the database.

1. Forward the PostgreSQL port to your machine. Keep this command running in its own terminal. Replace `svc/postgres` with your PostgreSQL service.

   ```sh
   kubectl -n vault-sync port-forward svc/postgres 5432:5432
   ```

2. Write the job token to a file:

   ```sh
   kubectl -n vault-sync get secret vault-sync-escrow-job-token -o jsonpath='{.data.token}' | base64 -d > token
   ```

3. Run the rotation. The database URL points at the forwarded port:

   ```sh
   VAULT_SYNC_DATABASE_URL='postgres://vault_sync_export@localhost:5432/vault_sync' \
   VAULT_SYNC_ESCROW_IDENTITY_FILE=./escrow.key \
   VAULT_SYNC_ESCROW_SIGNING_KEY_FILE=./signing.keys \
   VAULT_SYNC_ESCROW_JOB_TOKEN_FILE=./token \
   vault-sync-server export rotate-escrow -server https://sync.example.com \
     -recipient "$RECIPIENT" -signing-public-key "$SIGNING_PUBLIC_KEY"
   ```

4. Stop the port forward, and delete the `token` file.

#### As a one-off pod

You put the keys in a temporary Secret, and you delete it after the run.

1. Create the temporary Secret from the files on your machine. Include the job token:

   ```sh
   kubectl -n vault-sync get secret vault-sync-escrow-job-token -o jsonpath='{.data.token}' | base64 -d > token
   kubectl -n vault-sync create secret generic vault-sync-escrow-rotation \
     --from-file=escrow.key=./escrow.key --from-file=signing.keys=./signing.keys --from-file=token=./token
   ```

2. Run the rotation in a pod that mounts this Secret. Kubernetes deletes the pod when it ends, and the command prints the JSON summary:

   ```sh
   kubectl -n vault-sync run vault-sync-rotate-escrow --rm -i --restart=Never \
     --image=ghcr.io/soliddowant/vault-sync:VERSION --overrides='{
       "spec": {
         "securityContext": {"runAsNonRoot": true, "runAsUser": 65532, "runAsGroup": 65532},
         "volumes": [{"name": "keys", "secret": {"secretName": "vault-sync-escrow-rotation"}}],
         "containers": [{
           "name": "vault-sync-rotate-escrow",
           "image": "ghcr.io/soliddowant/vault-sync:VERSION",
           "args": ["export", "rotate-escrow", "-server", "https://sync.example.com",
                    "-recipient", "'"$RECIPIENT"'", "-signing-public-key", "'"$SIGNING_PUBLIC_KEY"'"],
           "env": [
             {"name": "VAULT_SYNC_DATABASE_URL", "value": "postgres://vault_sync_export@postgres:5432/vault_sync"},
             {"name": "VAULT_SYNC_ESCROW_IDENTITY_FILE", "value": "/keys/escrow.key"},
             {"name": "VAULT_SYNC_ESCROW_SIGNING_KEY_FILE", "value": "/keys/signing.keys"},
             {"name": "VAULT_SYNC_ESCROW_JOB_TOKEN_FILE", "value": "/keys/token"}
           ],
           "volumeMounts": [{"name": "keys", "mountPath": "/keys", "readOnly": true}]
         }]
       }
     }'
   ```

3. Delete the temporary Secret and the local `token` file at once, also when the run failed:

   ```sh
   kubectl -n vault-sync delete secret vault-sync-escrow-rotation
   rm token
   ```

## Reset the escrow chain

A reset starts the escrow chain again from a new escrow bundle without the old signing key. The escrow chain is the list of escrow bundles that the server publishes, from the first one to the current one. Use a reset only when a normal rotation is not possible or not safe:

- You lost the escrow signing key of the chain's current head.
- Somebody stole that signing key, and you want to leave the chain that the thief can extend.

`vault-sync-server export reset-escrow` appends a reset point to the chain. A reset point names the new bundle and has no signature. Devices do not trust it on their own. Each user must accept the new escrow fingerprint in the plugin, and the owner of each vault must adopt the new key ([When the escrow key changes](../user/encryption.md#when-the-escrow-key-changes)).

```sh
vault-sync-server export reset-escrow -server https://sync.example.com \
  -recipient age1pq1… -signing-public-key BASE64
```

The flags are the same as for `export rotate-escrow`. The command reads `VAULT_SYNC_DATABASE_URL` and the database TLS variables (it only reads the database, like the export), `VAULT_SYNC_LOG_LEVEL`, and `VAULT_SYNC_ESCROW_JOB_TOKEN_FILE`. It needs no escrow identity and no signing key. It reads the chain's head from PostgreSQL and writes the reset point through the server's job-only `EscrowJobService`. It prints one JSON line, `{"status":"ok"}` or `{"status":"failed","error":"…"}`. It exits `0` when it appended the reset point, `1` when it did not, and `2` for invalid flags.

The server refuses the reset in these cases:

- The head changed between the read and the write. Run the command again.
- The new bundle is malformed, or it is already in the chain. Every bundle has one position in the chain, so a reset back to an old bundle is not possible. Generate a new bundle.
- The deployment has no escrow chain yet. Start the server with an escrow key first.

### The order of steps for a reset

1. On your offline machine, generate a new escrow key and a new escrow signing key, as in step 1 of [The order of steps](#the-order-of-steps).
2. Run `export reset-escrow` with the new bundle. Use the same inputs as in [Run the rotation](#run-the-rotation), without the identity file and the signing key file.
3. Update the server: set `VAULT_SYNC_ESCROW_RECIPIENT` and `VAULT_SYNC_ESCROW_SIGNING_KEY` to the new bundle. The server refuses to start until the configuration names the chain's head.
4. Publish the new escrow fingerprint (see [Publish the escrow fingerprint](#publish-the-escrow-fingerprint)). Tell your users to compare it with the fingerprint that the plugin shows before they accept the reset.
5. Run `export rotate-escrow` with the new bundle and the old identity in the identity file. The chain's head is already the new bundle, so the run appends nothing. It re-wraps the escrow slots of each vault whose owner adopted the new key. The server refuses to re-wrap a slot of a vault whose owner did not adopt the key yet, and the run lists that slot in `failures`. This vault waits for its owner. Run the command again later.

Later rotations go from the new bundle with signed statements, as before.

### Destroy the old escrow identity after a reset

After a reset, keep the old escrow identity until the owner of every escrowed vault adopted the new key. Until then, only the old identity opens the escrow slots of the vaults that did not adopt it, and the export reads these vaults with it. This also applies to vaults with escrow off and to vaults deleted within the last 30 days. If you destroy the old identity before then, the vaults that did not adopt the new key lose escrow. The `failures` list of `export rotate-escrow` shows these vaults.

### A reset point that you did not make

Anyone with the job token can append a reset point. If somebody does, the server stops at its next start, because the chain's head is not the configured bundle. To recover, generate a fresh bundle, run `export reset-escrow` with it, and configure the server with it. You cannot reset back to the configured bundle, because that bundle is already in the chain. Then replace the job token. Devices that saw the unwanted reset point show the reset prompt to their users.

## When a member loses their passphrase

The devices of the member that were unlocked keep the key and the files of the vault, and keep syncing until the member signs out. Other members of a shared vault keep their own keys and passphrases.

Without escrow, the server's copy of a vault that no other member can open is lost. Nobody can decrypt it, also not you.

With escrow, you can restore the vault in one of two ways:

1. Run the export job. It writes the current files of the vault in plaintext. Give the member that copy.
2. Or import the plaintext copy into an encrypted vault with the import tool. The import unwraps the key of the vault through the escrow identity, and encrypts with it. Before you start, get the vault fingerprint from a member. The import uses it to make sure that the membership log of the vault is real, so it does not trust the server.

[Backup and restore](backup-and-restore.md) has the export and import steps.

## Recovery with age

An escrow key slot is a standard age file. So you can recover a vault key without any vault-sync software, for example from a database backup during disaster recovery. You need age 1.3 or later, the escrow identity, and read access to the PostgreSQL database or a dump of it.

1. Find the epochs of the vault. The database stores each vault key for each epoch:

   ```sh
   psql "$DATABASE_URL" -At -c "SELECT epoch FROM vault_key_epochs WHERE vault_id = '0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e' ORDER BY epoch"
   ```

2. Write the escrow slot of one epoch to a file:

   ```sh
   psql "$DATABASE_URL" -At -c "SELECT encode(wrapped_key, 'base64') FROM key_slots WHERE vault_id = '0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e' AND epoch = 1 AND recipient_kind = 'escrow'" | base64 -d > slot.age
   ```

   If the query returns no row, that epoch has no escrow slot. The vault had escrow turned off by then, or never had it.

3. Decrypt the slot with the escrow identity. The first 32 bytes are the vault key of the epoch:

   ```sh
   age --decrypt --identity escrow.key slot.age | head -c 32 > epoch-1.key
   ```

   The bytes after the first 32 name the vault, the epoch and the recipient that the slot was made for (the `slot_ad` of [`docs/design/crypto.md`](../design/crypto.md)). So you can make sure that you opened the slot that you meant to.

The vault key decrypts the contents and paths of the vault, in the formats of [`docs/design/crypto.md`](../design/crypto.md). In normal operation you never do this by hand. The export job does the same with the identity that it holds, and writes the vault in plaintext. These steps show that a vault with escrow stays recoverable without vault-sync. A test runs the `age` tool on an escrow slot to keep it that way.
