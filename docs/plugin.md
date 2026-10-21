# Obsidian plugin

This page covers the vault-sync plugin's settings, how it signs in, how a vault is connected, and what the sync status means. The server's configuration is in `docs/configuration.md`.

## Settings

Open **Settings → Vault Sync**.

| Setting | Meaning |
|---|---|
| Server URL | The vault-sync server's base URL, for example `https://sync.example.com`. |
| OIDC issuer URL | Optional. Leave it empty: the plugin uses the issuer the server advertises (its `VAULT_SYNC_OIDC_ISSUER_URL`). Enter it only for a server too old to advertise one, character for character (including any trailing slash), for example `https://auth.example.com/application/o/vault-sync/` for Authentik. An issuer that differs from the one the server advertises is refused, because the server accepts no other issuer's tokens. |
| OIDC client ID | Optional. Leave it empty to sign in as the client the server advertises (its `VAULT_SYNC_OIDC_CLIENT_ID`, by default its audience). Enter a client ID to sign in as another public client instead (see below). The access tokens it receives must carry the server's `VAULT_SYNC_OIDC_AUDIENCE`. |
| Device name | How this device is named when it registers with the server, and in the names of conflict copies it makes. In a copy's name, characters that some platform does not allow in file names, and `(` and `)`, become `-`, the name is cut to 40 characters, and a name with nothing left becomes `device`. Invisible characters (control and format characters, such as bidi controls or the zero-width joiner of some emoji, and line separators) are removed first, since the server refuses them in device names, and the registered name is cut to at most 256 bytes (the server's limit), never through a character. If the server still refuses the name (an older Android WebView may not know format characters added in recent Unicode versions, so it cannot remove them), the status says so and names this setting: change the name and sync registers the device with it when it tries again. Empty uses the platform's name (`Windows`, `Mac`, `Linux`, `Android`, `iOS`). The server keeps the name the device first registered with. |
| Remote vault | Shown while signed in: the server vault this vault syncs with, or controls to connect to one of your vaults or create a new one (see [Connecting a vault](#connecting-a-vault)). |
| Sync the config folder | Off by default. Syncs the selected parts of this vault's config folder on this device (see [Config folder sync](#config-folder-sync)). Turning it on is a security risk: plugins and settings synced from other devices, plugin code included, run on this device. |

Usually the server URL is all you enter. In that case the server URL decides the identity provider: the first sign-in trusts the issuer the server advertises, so a malicious or compromised server could send you to a sign-in page of its choosing. You already trust that server with your notes; to pin the identity provider anyway, enter the issuer. After you sign in, the issuer is stored with the refresh token, and refreshes use it whatever the server advertises later. The server URL and the issuer, whether entered or advertised by the server, must use `https`. Plain `http` works only for `localhost`, `127.0.0.1` and `::1`, for local development. While you are signed in, and while a sign-in is in progress, these settings are locked, because the refresh token belongs to that identity provider. Sign out to change them. While signed in, the empty issuer and client ID fields show the ones in use.

The settings live in the plugin's `data.json` under `.obsidian/plugins/vault-sync/`. That file also holds the refresh token while you are signed in, so treat it as a secret, together with the issuer and client ID it was issued for, so that refreshing it never depends on reaching the server. It also holds this device's registration, the connected vault and the config sync settings. vault-sync never syncs it, even with config folder sync on.

## Signing in

Click **Sign in** in the settings, or run the **Vault Sync: Sign in** command. The plugin signs in with the OAuth 2.0 Device Authorization Grant (RFC 8628), which works the same on desktop and Android and needs no redirect back into Obsidian. While signed in, **Sign in** is refused: sign out first. A sign-in goes like this:

1. The plugin calls the server's `GetServerInfo`, which needs no sign-in, to check that the server speaks a compatible protocol and to learn the issuer and client ID to sign in with (unless the settings override them). If neither the server nor the settings name one of them, the dialog says which one to enter in the settings.
2. It discovers the identity provider's endpoints from `<issuer>/.well-known/openid-configuration` and asks for a device code with the scopes `openid offline_access`.
3. A dialog shows a link to the verification page and a user code. Open the page in any browser, on this device or another one, sign in there and enter the code. **Copy code** and **Open page** help on mobile.
4. The plugin polls the identity provider at the interval it asks for, and slows down when told to. Once you approve, it stores the refresh token in plugin data and closes the dialog. Closing the dialog cancels the sign-in and leaves the device as it was (for example still needing a sign-in). If you deny the request or the code expires, the dialog says so. Start again to get a new code.

Access tokens are kept in memory only, never on disk. The plugin refreshes the access token with the refresh token before it expires: a minute before `exp`, or halfway through the token's lifetime if that is shorter. Concurrent requests share one refresh. If the server still refuses a token as unauthenticated (it expired early, or the device clock is off), the plugin refreshes and sends the request once more, unchanged. A retried commit keeps its revision id, so a commit whose first attempt was applied is not duplicated. When the identity provider rotates refresh tokens, the new one is saved before it is used.

### When the session ends

If the identity provider refuses the refresh token (it expired or was revoked, or your session there ended), the plugin forgets it, shows a notice, pauses sync, and the status bar shows **sign-in needed**. The settings then show **Sign in again**, which restarts the device flow. Local changes are not lost meanwhile: they stay on disk and in the sync journal, and sync, which starts again as soon as you sign in, pushes them. A network failure while refreshing does not sign you out. The plugin shows **offline** and tries again.

**Sign out** stops sync and forgets both tokens. The connected vault and this device's registration are kept, so signing in again with the same account resumes syncing.

The plugin never logs or displays tokens.

## Connecting a vault

Once signed in, the settings show a **Remote vault** section. Each local vault is connected to one vault on the server:

- **Connect to an existing vault** lists the vaults you are a member of. Vault names are shown as device names are in the history (see [History and restore](#history-and-restore)): without invisible characters, at most 64 characters, laid out on their own so right-to-left letters cannot reorder the sentence around them, and by the start of the vault's id when nothing visible is left. End-to-end encrypted vaults are not listed, because the plugin cannot sync them yet.
- **Create a vault** creates a vault on the server (plaintext, owned by you) and connects to it. Its name defaults to the local vault's name.

If both this vault and the remote vault already have files, the plugin asks before it connects. The two are then combined. Files only one side has are copied to the other, and nothing is deleted or overwritten. Where both sides have a file at the same path with different content, the remote version stays at that path, and this vault's version is kept next to it as a conflict copy, named `<name> (conflict <device> <date>).<ext>`.

**Disconnect** stops syncing this vault. Its sync journal is kept, so connecting to the same vault again carries on where it stopped. Changing the server URL (after signing out) disconnects the vault too, because a vault id means nothing on another server.

### Device registration

Before its first sync, each installation of the plugin (each local vault, on each device) registers itself with the server as a device, under the **Device name** setting. It registers once and keeps the device id in `data.json`, so restarts and new sign-ins with the same account reuse it. Signing in with another account, or to another server, registers a new device for that account. Every commit records the device it came from.

The server limits how many devices one user may have registered (100). Every installation, and every reinstall, registers a new device; the server can list and remove devices, and a removed device frees its place, but the plugin has no settings for that yet, so removing devices needs the server's API (see `docs/configuration.md`). When the limit is reached, the status shows **error** with the message that the account has reached the server's device limit, and sync does not start on this device. Local files are untouched. The plugin recognises the limit by the reason the server attaches to the refusal; against a server too old to send it, the refusal is shown as an ordinary error and retried instead. A crash or a lost connection while the device registers does not use a second place: the plugin saves a registration id first and the server returns the same device for it. If the server refuses the registration (for example the device's name), the next attempt registers afresh with the current Device name, so renaming the device fixes it.

## Sync

While signed in and connected, the plugin syncs on its own:

- When sync starts (Obsidian starting, the plugin enabled, a sign-in, a vault connected), it pulls the server's changes and then pushes every local change made since the last sync, including changes made while Obsidian was closed or the plugin was off.
- 2 seconds after your last edit, it pushes. A burst of edits becomes one revision.
- When another device commits a change, the server notifies this device over its realtime channel (a WebSocket to `/v1/realtime` on the configured server), and the plugin pulls at once.
- Every 30 seconds it pulls and pushes, which retries anything that failed and brings in other devices' changes even while the realtime channel is down.
- The **Vault Sync: Sync now** command does the same at once.

The server limits how many requests one account may have in progress at once (`VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER`, see `docs/configuration.md`). A single device stays far below the limit, but many devices syncing at once can reach it. When the server refuses a sync for that reason, the status shows **error** with the server's message. The plugin then waits before its next pull or push contacts the server, including **Sync now**. The wait is random, between half of a ceiling and the whole of it. The ceiling starts at 1 second and doubles with every refusal in a row, up to 1 minute. Once the wait is over, the plugin pushes, and the first sync that succeeds resets the ceiling. Nothing is lost while it waits: changes stay on disk and in the journal, and the plugin sends them again with the same revision ids.

Stopping sync (signing out, disabling the plugin, quitting) never loses a local change. An edit that was not pushed yet stays on disk, and the next sync finds and pushes it.

### Realtime channel

The realtime channel only makes changes arrive sooner; sync never depends on it (SPEC.md §6.4). Every time the plugin (re)subscribes, it pulls from where it left off, so a change made while it was disconnected is never missed.

- It authenticates with the same access token as the API, sent as the `vaultsync.bearer.` WebSocket subprotocol, never in the URL, and never logged. When the token expires the server closes the connection; the plugin gets a fresh token from its stored sign-in, with no prompt, and reconnects.
- When the connection drops or the server refuses it (the server restarting or draining, too many connections, the network going away), the plugin reconnects after a random delay that doubles with every consecutive failure, from about a second up to a minute. The delay starts over only once a connection has stayed up for 30 seconds. Meanwhile the 30-second sync keeps running.
- The server must allow Obsidian's origins (`app://obsidian.md`, `capacitor://localhost`, `http://localhost`; the server allows them by default), and a reverse proxy in front of it must pass WebSocket upgrades on `/v1/realtime` ([configuration](configuration.md)). Without the channel, changes from other devices still arrive within 30 seconds.

### Status

The status bar (desktop) shows the sync status. Mobile has no status bar, so there a ribbon icon shows it instead: a check mark when idle, an upload cloud while local changes wait to be pushed, a warning triangle while conflicts are unresolved, and its own icon for syncing, offline, error, sign-in needed and no vault connected. Click the status bar or tap the icon, or run **Vault Sync: Show sync status**, for details. The settings show it too.

| Status | Meaning |
|---|---|
| `starting` | Sync is starting: the plugin registers this device with the server and opens its sync journal. |
| `idle` | The last sync succeeded. |
| `syncing` | A pull or push is running. |
| `offline` | The server or the identity provider could not be reached, or the identity provider failed with a server error (HTTP 5xx). Local changes are kept, and the next sync pushes them. An identity provider that answers with something invalid (not JSON, a missing field) shows `error` instead, since that points at its configuration. |
| `error` | The last sync failed for another reason, or some local files cannot be synced because the server does not accept their paths. The details say why and name the file; the [conflict view](#conflicts) lists every such file. |
| `sign-in needed` | The session ended. Sign in again to resume. |
| `signed out` / `no vault connected` | Sync is off until you sign in and connect a vault. |
| `waiting for another window` | Another Obsidian window with this vault open runs an older Vault Sync and holds its sync journal. Close that window, or update Vault Sync there. |

After the status, `N pending` counts local changes that the server has not acknowledged yet (including edits made while the server is unreachable, before any push could record them; those are counted per file, from the moment Obsidian reports the change, until a push gets through), and `N conflicts` counts the conflicts not yet resolved: conflict copies that still exist, and conflicts logged without a copy (when no conflict-copy name fits, see below) whose document still waits to sync: the other device's version still waits, or, when another file took the path of a file you changed, your change is still pending. A conflict counts as resolved once you delete or rename its copy, or, for one without a copy, once its document no longer waits. The [conflict view](#conflicts) lists them.

### Conflicts

When this device and another one changed the same note on the same lines, edited the same attachment, or created a file at the same path, vault-sync keeps both versions and never writes conflict markers into a note. The other device's version stays at the path, and this device's version is kept next to it as a conflict copy, `<name> (conflict <device> <date>).<ext>`. The copy is an ordinary file and syncs to your other devices.

Only `.md`, `.txt`, `.css` and `.js` files are merged line by line, so edits on different lines of such a file on two devices combine without a conflict. Every other file (attachments, `.json`, `.csv`, `.canvas` and any other text file) is handled as a whole: concurrent edits of it always make a conflict copy, even on different lines (SPEC.md §7).

Run **Vault Sync: Show conflicts** to open the conflict view in the right sidebar. It lists each unresolved conflict, newest first, with:

- why it happened and when;
- a link to the version that stayed in place (it follows the note if it was renamed since) and a link to the conflict copy (Ctrl/Cmd-click opens it in a new tab);
- **Compare side by side**, which opens the two versions next to each other in a new tab. On a phone, where Obsidian shows one pane at a time, both open and you switch between them.

Copy what you need from the conflict copy into the note, then delete the copy. Deleting (or renaming) the copy resolves the conflict: its entry disappears from the view, and the status no longer counts it. The view only reads the sync journal, so resolving a conflict on another device (deleting the copy there) clears it here too once that delete has synced.

When no conflict-copy name fits the path length limits (a very deep folder), nothing is copied: this device's version stays where it is, unsynced, and the view says so. Move the file to a shorter path to sync it.

A note edited on two devices can also end up with a conflict copy when the two edits do not overlap: if one device was offline for longer than the server keeps old versions (see [History and restore](#history-and-restore)), the version both edits started from may have been removed from the server, so vault-sync cannot merge them and keeps both. The view explains this as "no longer kept on the server".

The view also lists **files this device cannot hold**: documents whose path on the server is not a valid file name on this device's platform, such as `CON.md` or a name with `?` on Windows, or a name longer than 255 bytes anywhere. Each shows its path on the server and why it cannot be written here, and links to the earlier version if this device still has one. Such a document is never dropped or renamed on the server. Rename it on another device and it arrives here. Until then, local changes to its earlier version are not synced. If another device puts a different note at the earlier version's path, that note takes the path here too, and the earlier version, with its local changes, is kept as a conflict copy and synced as a new note.

It also lists **files too large for this device**: documents whose newest version on the server is larger than this device downloads, 1 GiB on desktop and 256 MiB on a phone or tablet (a download is held in memory whole, and mobile devices have far less of it). Each shows its path on the server and the version's size, and links to the earlier version if this device still has one. Nothing on this device is changed or removed, and the rest of the vault keeps syncing. A smaller version of the file (saved on another device) arrives here as usual and removes the entry. Until then, local changes to the earlier version are not synced.

Finally, it lists **files that are not synced**: local files whose path the server does not accept. vault-sync checks every path against the server's rules before it sends anything, so such a file is never uploaded, and it stays on this device, untouched. A path is refused if it contains a control character (such as a line break or a tab, which Linux and Android allow in file names), if a folder or file name in it is made only of dots and spaces (such as `...`), if it is longer than 4096 bytes, or longer than 8192 bytes once its letters are normalized (a few characters, such as some musical symbols, grow when normalized), or, for a new file, if it contains a backslash (`\`) or starts with a character and a colon (`1:x.md`). Each entry shows the path, with any invisible character written as `\uXXXX` (a line break shows as `\u000A`), and why it is refused. The status shows `error` and names the file (or the first of several) with the reason. Rename or move the file to a valid path and it syncs like any other; delete it and the entry disappears too.

The same section lists changes from other devices that cannot be written here because of their path. Each entry shows the path on the server and why. Nothing is lost: the change waits on this device and arrives once its path can be written, or is replaced by a later change of the same file. The reasons are:

- the path is not a valid path for a file in a vault (it starts with a slash or a drive letter, a name in it is made only of dots, it contains a control character, or it is not valid text);
- Obsidian would store the path under another name: Obsidian rewrites letters written in another Unicode form (an accent typed as a separate character, as some macOS tools write names) and non-breaking spaces, so the note would land at a different path. Rename it on another device;
- a folder or file name in the path starts with a dot, which Obsidian hides and vault-sync does not sync as a note;
- a file or folder on this device is in the way at that path; the change arrives once the path is free;
- another device moved a note into a part of the config folder this device does not sync, while this device still has the note. The note stays where it is here, with any local edits, and the entry links to it; its changes are not synced while it is parked. Only a client other than vault-sync can make such a move.

When a file is open in a view that cannot take an incoming change (a Markdown editor whose unsaved edits overlap it, a canvas or another plugin's view with unsaved changes, or a change whose content is not text), sync waits at that change: vault-sync saves the view and writes nothing. The section names the file as **Waiting for**, until the next sync gets past it. Saving or closing the file lets sync continue.

A link in the view whose file no longer exists (removed since the view was drawn) shows a notice and redraws the view.

## Config folder sync

By default vault-sync syncs only your notes and attachments. Nothing in the vault's config folder (`.obsidian`, or the name set under **Settings → Files and links → Override config folder**) is uploaded or written. **Sync the config folder** changes that for this vault on this device only. The setting is kept in the plugin's `data.json` on the device. It is never synced and never set by the server, so every device opts in by itself, and nobody else can turn it on for you.

> **Security risk.** With config sync on, settings and plugins from any device that syncs this vault apply on this device, and with **Plugin code and data** on, plugin code from those devices runs here with full access to the device. In a vault you share, that means code from every member with edit rights. Turn it on only for vaults you trust, where you want this folder synced.

With the toggle on, you choose what syncs. Every category is a separate toggle:

| Category | Default when turned on | Files (inside the config folder) |
|---|---|---|
| Themes | on | `themes/` and `appearance.json` (the chosen theme, enabled snippets and other appearance settings) |
| CSS snippets | on | `snippets/` and `appearance.json` |
| Hotkeys | on | `hotkeys.json` |
| Enabled plugin list | off | `core-plugins.json` and `community-plugins.json` |
| Plugin code and data | off | `plugins/<plugin>/`: each community plugin's code, manifest, styles and settings |

No other file in the config folder syncs, whatever is selected. That covers `app.json` (Editor and Files and links settings), the core plugins' own settings files (`daily-notes.json`, `templates.json`, `bookmarks.json`, `types.json` and so on) and any other file in it.

On the server, config files are always stored under `.obsidian/`. Each device reads and writes them in its own config folder, so a device whose config folder is called `.obsidian-mobile` syncs with devices that use `.obsidian`.

### Files that never sync

These files hold state that belongs to one device. They never sync, even with every category on, and a revision of one of them that some other client uploads is never written to disk. The list comes from running the pinned Obsidian version (1.14.4, the version in the e2e suite), desktop and emulated mobile. The research took a snapshot of the config folder before and after each of these actions: opening and closing notes, opening a note in a new tab, switching tabs, splitting a pane, switching to reading view, toggling and resizing the sidebars, folding a heading, scrolling, resizing the window, changing the theme, opening the graph view, the local graph, a canvas, search, the file explorer, the outline, backlinks and tags, renaming and deleting notes, opening a daily note, adding properties, toggling a core plugin, bookmarking, the command palette, the quick switcher, the settings, and restarting Obsidian.

| File | Why it is device-local |
|---|---|
| `workspace.json` | The desktop layout: open tabs and splits, their sizes, the sidebars, the active pane, each view's state (mode, cursor, folds) and the recently opened files. Obsidian rewrites it on every pane or tab switch, opened or closed note, split, sidebar toggle or resize, view-mode change and fold. Syncing it would conflict constantly and move every device's panes around. |
| `workspace-mobile.json` | The same layout state for the mobile app, rewritten just as often. |
| `workspace*.json` (any other) | For example `workspaces.json`, the layouts the Workspaces core plugin saves, which are laid out for one device's screen. |
| `graph.json` | The graph view's settings, together with its current zoom level. Obsidian writes it when the graph view opens and on every zoom. |
| `plugins/vault-sync/` (and the folder vault-sync is installed in) | vault-sync's own code and its `data.json`, which holds this device's refresh token, registration and settings. |

The research found that scrolling, resizing or moving the window, the quick switcher, the command palette, search and indexing (the metadata cache) write nothing to the config folder. Obsidian keeps that state outside the vault (the window state, and IndexedDB and local storage for caches and history). The other changes it found were to settings files, which change only when you change a setting: `appearance.json` (the theme), `core-plugins.json` (a core plugin turned on or off) and `community-plugins.json`.

### How config changes arrive

Obsidian reads its config files when it starts and keeps its own copy in memory. When sync changes a config file, vault-sync shows a notice asking you to reload Obsidian. Run **Reload app without saving** from the command palette. vault-sync never reloads Obsidian by itself. Until you reload, Obsidian keeps using the old settings and may write them back when you change a setting, which would undo the synced change.

- vault-sync learns about changes in the config folder from Obsidian's raw file events. The desktop app reports them (the e2e suite checks this, on desktop and in emulated mobile mode), and a change is then pushed like a note edit, 2 seconds after Obsidian writes it. Whether the Android app reports them has not been checked on a device yet. Where they are not reported, the change is pushed the next time sync starts (Obsidian starting, the plugin enabled, a sign-in, a change to these settings), because every start compares the whole folder with the journal.
- If two devices change the same config file, the usual merge rules apply (SPEC.md §7). CSS and JavaScript files merge line by line. JSON settings files are blobs: the other device's version stays in place, and this device's version is kept next to it as a conflict copy, for example `.obsidian/hotkeys (conflict Laptop 2026-10-18 101500).json`. Such copies stay on the device and do not sync, wherever they are, including inside synced folders such as `snippets/` or `plugins/<id>/`: a copy like `.obsidian/plugins/dataview/data (conflict Laptop 2026-10-18 101500).json` never reaches another device. Obsidian does not show files in the config folder, so delete the copy with your file manager once you have looked at it. Until then it counts as a conflict in the status.
- The first time you turn it on, in a vault whose config files another device has already synced, this device's own differing versions of those files become conflict copies in the same way, and the synced versions apply.
- Turning the toggle or a category off stops syncing those files on this device. Nothing is deleted, here or on the server, and other devices keep them. Changes that arrive meanwhile are applied once you turn it on again.

## History and restore

The server keeps every revision of every file until its retention policy thins old ones out (by default everything for 90 days, then one revision per day for a year, then one per week; see "Retention and history" in [configuration](configuration.md)). A file's current revision is never removed, and neither is the record that a file was deleted.

- **Vault Sync: Show file history** (for the open file), or **Show sync history** in a file's context menu, lists the file's revisions, newest first. Each line shows when the server received the revision, which device made it (`this device`, or another device by the name it was registered with, in quotes, with invisible formatting characters such as bidi controls removed, double quotation marks shown as `'`, at most 64 characters (longer names end in `…`) and laid out on their own (a Unicode bidi isolate), so right-to-left letters in it cannot reorder the line, or by the start of its id when the server does not name it), and what changed (edited, moved, deleted, restored). Paths are another member's text too: in the history, the deleted-files list and the conflict view, a path's invisible characters (control and format characters such as bidi controls and zero-width characters, and line separators) are written as `\uXXXX`, so a name cannot pass for another one (a right-to-left override shows as `\u202E`). Only the display changes: the file keeps its name on disk and on the server, and restoring uses its real path. Every member of the vault sees the names of the devices that changed its files. Older revisions load with **Load older versions**.
- Choose a revision to preview it. Text is shown as it is (the start of a very long file only); other files by size.
- **Restore this version** makes the chosen revision the file's current content again. Nothing is overwritten: the restore is a new revision on top of the current one, so the version it replaces stays in the history, and it reaches your other devices like any edit. Local edits not synced yet are pushed first, so they are in the history too. The file keeps its current name and folder.
- **Vault Sync: Browse deleted files** lists the deleted files this device knows of, most recently deleted first. Choose one to see its history: the newest entry is the delete, whose preview shows the file as it was when it was deleted. Restoring that entry, or any older one, brings the file back where it was, or, if another file has taken that path since, at a path you choose (see below). Config files are listed only while config sync and their category are on: restored with sync of them off, they would not show up on this device.
- Members with the `viewer` role can browse history and preview versions but not restore them, so the modal offers no **Restore this version** button to them. If the plugin cannot read the role (the server is unreachable, say), it offers the button and the server decides.

If another file has taken a deleted file's path, the restore fails at first and the modal then offers **Restore at another path**, filled in with a free path next to the old one (`plan (restored).md`). Edit it if you like, and **Restore here** brings the file back there, with its history. If the path you typed cannot be used, the field keeps it for you to correct; if another file has taken it too, the field suggests a free path next to it. The path must be one the server accepts for a new file, that this device can hold and that the vault syncs now (a config file path only while config sync and its category are on). Or move the other file away and restore again. History is only available while the vault syncs (signed in and connected).

## Identity provider setup (Authentik)

Create an OAuth2/OpenID provider and an application for vault-sync:

- **Client type:** public. The plugin cannot keep a client secret.
- **Device code flow:** enabled (in Authentik, the brand's *Device code flow* setting). If the provider's OpenID configuration has no `device_authorization_endpoint`, the plugin reports that the device authorization grant is not supported.
- **Scopes:** include `offline_access`, so that a refresh token is issued. The plugin refuses a sign-in that returns no refresh token.
- **Audience:** Authentik puts the client ID in the access token's `aud`, so set the server's `VAULT_SYNC_OIDC_AUDIENCE` to the client ID. The server then advertises that client ID to the plugin, and nothing needs to be entered in the plugin besides the server URL. With a provider whose access tokens carry another audience, also set the server's `VAULT_SYNC_OIDC_CLIENT_ID` to the plugin's client ID.
- **Token lifetimes:** any access-token lifetime works, because the plugin refreshes ahead of expiry. The refresh-token lifetime decides how long a device that stays offline remains signed in.
