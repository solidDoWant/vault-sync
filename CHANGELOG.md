# Changelog

All notable changes to vault-sync are listed here, newest release first.

## 0.3.0

The first public release of vault-sync, a self-hosted replacement for Obsidian Sync. It covers single-user sync (Phase 2) and vault sharing (Phase 3); there is no separate 0.2.0. Install the server from the image `ghcr.io/soliddowant/vault-sync:0.3.0` or the Helm chart, and the plugin with BRAT from this repository's GitHub releases.

### Sync

- Sync an Obsidian vault across desktop and mobile devices through your own server. Notes, attachments and folders sync automatically: at startup, 2 seconds after you stop typing, every 30 seconds, and with **Vault Sync: Sync now**. Changes made while Obsidian was closed are found and synced at the next start. ([#55](https://github.com/solidDoWant/vault-sync/pull/55), [#98](https://github.com/solidDoWant/vault-sync/pull/98), [#153](https://github.com/solidDoWant/vault-sync/pull/153), [#164](https://github.com/solidDoWant/vault-sync/pull/164), [#220](https://github.com/solidDoWant/vault-sync/pull/220), [#1123](https://github.com/solidDoWant/vault-sync/pull/1123), [#1131](https://github.com/solidDoWant/vault-sync/pull/1131))
- Changes from other devices arrive within seconds over a realtime connection. Sync never depends on that connection: if it drops, changes still arrive within 30 seconds, and the plugin reconnects on its own. ([#114](https://github.com/solidDoWant/vault-sync/pull/114), [#236](https://github.com/solidDoWant/vault-sync/pull/236))
- Large files upload and download in chunks, and an interrupted upload resumes where it stopped. ([#94](https://github.com/solidDoWant/vault-sync/pull/94), [#164](https://github.com/solidDoWant/vault-sync/pull/164))
- Renames and moves keep a note's identity and history on every device, including renames that change only letter case and renames made while Obsidian was closed. Deletes sync too, and an edit or rename that hasn't synced yet wins over another device's delete. ([#196](https://github.com/solidDoWant/vault-sync/pull/196), [#1129](https://github.com/solidDoWant/vault-sync/pull/1129))
- Folders sync, empty ones included. Creating, renaming or deleting a folder does the same on your other devices. ([#1125](https://github.com/solidDoWant/vault-sync/pull/1125), [#1140](https://github.com/solidDoWant/vault-sync/pull/1140), [#1152](https://github.com/solidDoWant/vault-sync/pull/1152))
- Remote changes never overwrite unsaved typing. A note or canvas open in the editor keeps your cursor and unsaved keystrokes while another device's change is merged in. ([#162](https://github.com/solidDoWant/vault-sync/pull/162), [#230](https://github.com/solidDoWant/vault-sync/pull/230))
- A crash, a power cut or quitting Obsidian during sync loses no change. The next sync picks up where it left off. ([#175](https://github.com/solidDoWant/vault-sync/pull/175), [#1128](https://github.com/solidDoWant/vault-sync/pull/1128))
- When the server is restored from a backup, every device notices and resyncs instead of losing or duplicating notes. ([#350](https://github.com/solidDoWant/vault-sync/pull/350), [#506](https://github.com/solidDoWant/vault-sync/pull/506), [#1128](https://github.com/solidDoWant/vault-sync/pull/1128))
- Files a device can't store, such as one too large for a phone or a path too long for Windows, stay on the server and on your other devices and are listed in the conflict view. The rest of the vault keeps syncing. Names the server refuses are listed with the reason and sync once you rename them. ([#217](https://github.com/solidDoWant/vault-sync/pull/217), [#294](https://github.com/solidDoWant/vault-sync/pull/294), [#1137](https://github.com/solidDoWant/vault-sync/pull/1137))
- The status bar on desktop, or a ribbon icon on mobile, shows the sync state: idle, syncing, offline, pending changes, unresolved conflicts, and errors. ([#220](https://github.com/solidDoWant/vault-sync/pull/220), [#547](https://github.com/solidDoWant/vault-sync/pull/547))

### Conflicts and history

- Edits to different lines of the same note on two devices are merged with no conflict. A conflict that can't be merged keeps both versions: yours is saved next to the note as a conflict copy, never as conflict markers inside it. ([#173](https://github.com/solidDoWant/vault-sync/pull/173), [#763](https://github.com/solidDoWant/vault-sync/pull/763), [#1129](https://github.com/solidDoWant/vault-sync/pull/1129))
- The conflict view lists every conflict copy, with a side-by-side compare, and the files that aren't on this device or aren't synced. ([#245](https://github.com/solidDoWant/vault-sync/pull/245), [#294](https://github.com/solidDoWant/vault-sync/pull/294), [#524](https://github.com/solidDoWant/vault-sync/pull/524))
- Browse every revision of a file, preview it and restore it. A restore is a new revision, so nothing is overwritten. If another file now has the name, the file can be restored at another path. ([#249](https://github.com/solidDoWant/vault-sync/pull/249), [#547](https://github.com/solidDoWant/vault-sync/pull/547), [#685](https://github.com/solidDoWant/vault-sync/pull/685))
- The history and conflict copy names show which user and which device made each change. ([#547](https://github.com/solidDoWant/vault-sync/pull/547), [#1158](https://github.com/solidDoWant/vault-sync/pull/1158))
- The server keeps the full history for 90 days, then one revision a day for a year, then one a week. Operators can change the policy for the server or for a single vault. ([#219](https://github.com/solidDoWant/vault-sync/pull/219), [#515](https://github.com/solidDoWant/vault-sync/pull/515), [#541](https://github.com/solidDoWant/vault-sync/pull/541))

### Sharing

- Share a vault: owners invite people with a one-time code as owner, editor or viewer, change their roles and remove them. Invitees join from the plugin settings. ([#640](https://github.com/solidDoWant/vault-sync/pull/640), [#680](https://github.com/solidDoWant/vault-sync/pull/680))
- Viewers get a read-only copy. Notes open read-only, nothing is uploaded, and a file changed on a viewer's device is moved aside to `.vault-sync/local-copies/` while the shared version is restored. ([#1157](https://github.com/solidDoWant/vault-sync/pull/1157))
- Leave a vault, or delete it as its owner. A device that loses access stops syncing and keeps every local file. The server keeps a deleted vault for 30 days, during which the operator can restore it. ([#1180](https://github.com/solidDoWant/vault-sync/pull/1180), [#1182](https://github.com/solidDoWant/vault-sync/pull/1182), [#1183](https://github.com/solidDoWant/vault-sync/pull/1183))

### Devices and sign-in

- Sign in through your identity provider (OIDC) with a device code. The session refreshes on its own and asks you to sign in again only when it really ends. ([#74](https://github.com/solidDoWant/vault-sync/pull/74), [#192](https://github.com/solidDoWant/vault-sync/pull/192), [#235](https://github.com/solidDoWant/vault-sync/pull/235))
- Each installation registers as a named device. List and remove your devices in the settings, which frees a place under the per-account device limit. A removed device stops syncing and can be registered again. ([#220](https://github.com/solidDoWant/vault-sync/pull/220), [#588](https://github.com/solidDoWant/vault-sync/pull/588), [#618](https://github.com/solidDoWant/vault-sync/pull/618))

### Server and deployment

- A Go server backed by PostgreSQL (14 or newer) and S3, shipped as an OCI image with a Helm chart. It runs as several stateless replicas, drains gracefully on shutdown, and exposes health checks and Prometheus metrics. ([#56](https://github.com/solidDoWant/vault-sync/pull/56), [#68](https://github.com/solidDoWant/vault-sync/pull/68), [#99](https://github.com/solidDoWant/vault-sync/pull/99), [#238](https://github.com/solidDoWant/vault-sync/pull/238))
- `vault-sync-server export` writes a plaintext copy of every vault to a directory, for backup or tape archival. ([#152](https://github.com/solidDoWant/vault-sync/pull/152))
- `vault-sync-server import` loads an existing folder of notes, such as an Obsidian vault, into a new vault. ([#1126](https://github.com/solidDoWant/vault-sync/pull/1126))

### Security

- Every request is authenticated, and every vault operation checks the caller's role in the vault. Request sizes, uploads, pages, connections and each user's concurrent requests are all bounded. ([#74](https://github.com/solidDoWant/vault-sync/pull/74), [#82](https://github.com/solidDoWant/vault-sync/pull/82), [#118](https://github.com/solidDoWant/vault-sync/pull/118), [#120](https://github.com/solidDoWant/vault-sync/pull/120), [#145](https://github.com/solidDoWant/vault-sync/pull/145), [#198](https://github.com/solidDoWant/vault-sync/pull/198))
- Paths must be portable: the server refuses names that some platforms can't store, such as Windows reserved names or a backslash, so a vault stays usable on every device. ([#144](https://github.com/solidDoWant/vault-sync/pull/144), [#283](https://github.com/solidDoWant/vault-sync/pull/283), [#291](https://github.com/solidDoWant/vault-sync/pull/291), [#1127](https://github.com/solidDoWant/vault-sync/pull/1127), [#1177](https://github.com/solidDoWant/vault-sync/pull/1177))
- Names from other members (device names, user names, paths) are displayed safely: invisible and right-to-left control characters can't disguise one name as another. ([#553](https://github.com/solidDoWant/vault-sync/pull/553), [#599](https://github.com/solidDoWant/vault-sync/pull/599), [#612](https://github.com/solidDoWant/vault-sync/pull/612))
- The refresh token is kept in Obsidian's local storage, not in the vault's files, so tools that back up or sync the vault folder never copy it. ([#460](https://github.com/solidDoWant/vault-sync/pull/460), [#1179](https://github.com/solidDoWant/vault-sync/pull/1179))
- Set up an end-to-end encryption key for your account, protected by a recovery passphrase that the server never sees. This is the first step towards end-to-end encrypted vaults, which can't be created or synced yet. ([#638](https://github.com/solidDoWant/vault-sync/pull/638), [#670](https://github.com/solidDoWant/vault-sync/pull/670), [#672](https://github.com/solidDoWant/vault-sync/pull/672), [#689](https://github.com/solidDoWant/vault-sync/pull/689), [#698](https://github.com/solidDoWant/vault-sync/pull/698), [#703](https://github.com/solidDoWant/vault-sync/pull/703), [#718](https://github.com/solidDoWant/vault-sync/pull/718))

### Fixes

These fix features built earlier in this release cycle.

- A folder tree deleted on one device no longer comes back when another device syncs partway through the delete. ([#1194](https://github.com/solidDoWant/vault-sync/pull/1194))
- A change sent just before its author was removed or demoted to viewer is refused instead of applied. ([#1196](https://github.com/solidDoWant/vault-sync/pull/1196))
- Remote changes now reach a note that is open in reading view. ([#1186](https://github.com/solidDoWant/vault-sync/pull/1186))
- A note deleted and replaced by renaming another note onto its name now syncs correctly. ([#1173](https://github.com/solidDoWant/vault-sync/pull/1173))
- A rename onto a name this device is giving up, and a change whose reply was lost, no longer get stuck. ([#1171](https://github.com/solidDoWant/vault-sync/pull/1171), [#1174](https://github.com/solidDoWant/vault-sync/pull/1174))
- A resync after a server restore no longer stops at a file this device can't store, and no longer loses a note to a name the restore gave another note. ([#1164](https://github.com/solidDoWant/vault-sync/pull/1164), [#1175](https://github.com/solidDoWant/vault-sync/pull/1175))
- Remote files named like vault-sync's temporary files are skipped instead of disrupting sync. ([#1176](https://github.com/solidDoWant/vault-sync/pull/1176))
- A device that leaves viewer mode, by disconnecting or switching to a vault where it is an editor, syncs normally again. ([#1178](https://github.com/solidDoWant/vault-sync/pull/1178))
- A former owner's pending invitations are deleted with their membership. ([#1189](https://github.com/solidDoWant/vault-sync/pull/1189))
- Replacing a file no longer waits several seconds for the vault index. ([#1191](https://github.com/solidDoWant/vault-sync/pull/1191))
- A note deleted while open in the editor no longer loses unsaved keystrokes. ([#340](https://github.com/solidDoWant/vault-sync/pull/340))
- A connection that silently stops answering now shows as offline instead of hanging, and an account at the server's request limit backs off and retries. ([#288](https://github.com/solidDoWant/vault-sync/pull/288), [#560](https://github.com/solidDoWant/vault-sync/pull/560), [#732](https://github.com/solidDoWant/vault-sync/pull/732))
- Canvas files merge field by field without dropping fields, and Android file errors are handled. ([#542](https://github.com/solidDoWant/vault-sync/pull/542), [#554](https://github.com/solidDoWant/vault-sync/pull/554), [#711](https://github.com/solidDoWant/vault-sync/pull/711))
- Server hardening: S3 certificate checks, upload session cleanup, fair sharing of server work between users, retention and garbage-collection fixes, and a safe shutdown drain. ([#143](https://github.com/solidDoWant/vault-sync/pull/143), [#177](https://github.com/solidDoWant/vault-sync/pull/177), [#199](https://github.com/solidDoWant/vault-sync/pull/199), [#382](https://github.com/solidDoWant/vault-sync/pull/382), [#387](https://github.com/solidDoWant/vault-sync/pull/387), [#438](https://github.com/solidDoWant/vault-sync/pull/438), [#461](https://github.com/solidDoWant/vault-sync/pull/461), [#489](https://github.com/solidDoWant/vault-sync/pull/489))
- Export hardening: no readable note is left out because of its path, and staging and lock files are handled safely. ([#188](https://github.com/solidDoWant/vault-sync/pull/188), [#197](https://github.com/solidDoWant/vault-sync/pull/197), [#492](https://github.com/solidDoWant/vault-sync/pull/492), [#501](https://github.com/solidDoWant/vault-sync/pull/501))
- Sign-in hardening: OIDC keys are fetched over HTTPS only, and identity claims and device names are checked. ([#83](https://github.com/solidDoWant/vault-sync/pull/83), [#90](https://github.com/solidDoWant/vault-sync/pull/90), [#445](https://github.com/solidDoWant/vault-sync/pull/445))
- Updated Go to fix standard-library vulnerabilities. ([#168](https://github.com/solidDoWant/vault-sync/pull/168), [#604](https://github.com/solidDoWant/vault-sync/pull/604))

Plus internal test, CI, tooling and process work.

### Known issues

- None. No bugs are open at release time.
