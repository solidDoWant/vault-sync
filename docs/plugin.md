# Obsidian plugin

This page covers the vault-sync plugin's settings, how it signs in, how a vault is connected, and what the sync status means. The server's configuration is in `docs/configuration.md`.

## Settings

Open **Settings → Vault Sync**.

| Setting | Meaning |
|---|---|
| Server URL | The vault-sync server's base URL, for example `https://sync.example.com`. |
| OIDC issuer URL | Optional. Leave it empty: the plugin uses the issuer the server advertises (its `VAULT_SYNC_OIDC_ISSUER_URL`). Enter it only for a server too old to advertise one, character for character (including any trailing slash), for example `https://auth.example.com/application/o/vault-sync/` for Authentik. An issuer that differs from the one the server advertises is refused, because the server accepts no other issuer's tokens. |
| OIDC client ID | Optional. Leave it empty to sign in as the client the server advertises (its `VAULT_SYNC_OIDC_CLIENT_ID`, by default its audience). Enter a client ID to sign in as another public client instead (see below). The access tokens it receives must carry the server's `VAULT_SYNC_OIDC_AUDIENCE`. |
| Device name | How this device is named when it registers with the server, and in the names of conflict copies it makes. Empty uses the platform's name (`Windows`, `Mac`, `Linux`, `Android`, `iOS`). The server keeps the name the device first registered with. |
| Remote vault | Shown while signed in: the server vault this vault syncs with, or controls to connect to one of your vaults or create a new one (see [Connecting a vault](#connecting-a-vault)). |

Usually the server URL is all you enter. The server URL and the issuer, whether entered or advertised by the server, must use `https`. Plain `http` works only for `localhost`, `127.0.0.1` and `::1`, for local development. While you are signed in, and while a sign-in is in progress, these settings are locked, because the refresh token belongs to that identity provider. Sign out to change them. While signed in, the empty issuer and client ID fields show the ones in use.

The settings live in the plugin's `data.json` under `.obsidian/plugins/vault-sync/`. That file also holds the refresh token while you are signed in, so treat it as a secret, together with the issuer and client ID it was issued for, so that refreshing it never depends on reaching the server. It also holds this device's registration and the connected vault. vault-sync never syncs it.

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

- **Connect to an existing vault** lists the vaults you are a member of. End-to-end encrypted vaults are not listed, because the plugin cannot sync them yet.
- **Create a vault** creates a vault on the server (plaintext, owned by you) and connects to it. Its name defaults to the local vault's name.

If both this vault and the remote vault already have files, the plugin asks before it connects. The two are then combined. Files only one side has are copied to the other, and nothing is deleted or overwritten. Where both sides have a file at the same path with different content, the remote version stays at that path, and this vault's version is kept next to it as a conflict copy, named `<name> (conflict <device> <date>).<ext>`.

**Disconnect** stops syncing this vault. Its sync journal is kept, so connecting to the same vault again carries on where it stopped. Changing the server URL (after signing out) disconnects the vault too, because a vault id means nothing on another server.

### Device registration

Before its first sync, each installation of the plugin (each local vault, on each device) registers itself with the server as a device, under the **Device name** setting. It registers once and keeps the device id in `data.json`, so restarts and new sign-ins with the same account reuse it. Signing in with another account, or to another server, registers a new device for that account. Every commit records the device it came from.

The server limits how many devices one user may register (100). The limit counts every registration ever made, and the server cannot list or remove devices yet ([#205](https://github.com/solidDoWant/vault-sync/issues/205)). When the limit is reached, the status shows **error** with the message that the account has reached the server's device limit, and sync does not start on this device. Local files are untouched. The limit is fixed, and there is no supported remedy yet (see `docs/configuration.md`), so this needs the server's operator.

## Sync

While signed in and connected, the plugin syncs on its own:

- When sync starts (Obsidian starting, the plugin enabled, a sign-in, a vault connected), it pulls the server's changes and then pushes every local change made since the last sync, including changes made while Obsidian was closed or the plugin was off.
- 2 seconds after your last edit, it pushes. A burst of edits becomes one revision.
- When another device commits a change, the server notifies this device over its realtime channel (a WebSocket to `/v1/realtime` on the configured server), and the plugin pulls at once.
- Every 30 seconds it pulls and pushes, which retries anything that failed and brings in other devices' changes even while the realtime channel is down.
- The **Vault Sync: Sync now** command does the same at once.

Stopping sync (signing out, disabling the plugin, quitting) never loses a local change. An edit that was not pushed yet stays on disk, and the next sync finds and pushes it.

### Realtime channel

The realtime channel only makes changes arrive sooner; sync never depends on it (SPEC.md §6.4). Every time the plugin (re)subscribes, it pulls from where it left off, so a change made while it was disconnected is never missed.

- It authenticates with the same access token as the API, sent as the `vaultsync.bearer.` WebSocket subprotocol, never in the URL, and never logged. When the token expires the server closes the connection; the plugin gets a fresh token from its stored sign-in, with no prompt, and reconnects.
- When the connection drops or the server refuses it (the server restarting or draining, too many connections, the network going away), the plugin reconnects after a random delay that doubles with every consecutive failure, from about a second up to a minute. Meanwhile the 30-second sync keeps running.
- The server must allow Obsidian's origins (`app://obsidian.md`, `capacitor://localhost`, `http://localhost`; the server allows them by default), and a reverse proxy in front of it must pass WebSocket upgrades on `/v1/realtime` ([configuration](configuration.md)). Without the channel, changes from other devices still arrive within 30 seconds.

### Status

The status bar (desktop) shows the sync status. Click it, or run **Vault Sync: Show sync status** (on mobile, where there is no status bar), for details. The settings show it too.

| Status | Meaning |
|---|---|
| `idle` | The last sync succeeded. |
| `syncing` | A pull or push is running. |
| `offline` | The server or the identity provider could not be reached. Local changes are kept, and the next sync pushes them. |
| `error` | The last sync failed for another reason, or the server refused some local changes. The details say why. |
| `sign-in needed` | The session ended. Sign in again to resume. |
| `signed out` / `no vault connected` | Sync is off until you sign in and connect a vault. |
| `waiting for another window` | Another Obsidian window with this vault open runs an older Vault Sync and holds its sync journal. Close that window, or update Vault Sync there. |

After the status, `N pending` counts local changes that the server has not acknowledged yet, and `N conflicts` counts conflict copies that still exist. A conflict counts as resolved once you delete or rename its copy.

## Identity provider setup (Authentik)

Create an OAuth2/OpenID provider and an application for vault-sync:

- **Client type:** public. The plugin cannot keep a client secret.
- **Device code flow:** enabled (in Authentik, the brand's *Device code flow* setting). If the provider's OpenID configuration has no `device_authorization_endpoint`, the plugin reports that the device authorization grant is not supported.
- **Scopes:** include `offline_access`, so that a refresh token is issued. The plugin refuses a sign-in that returns no refresh token.
- **Audience:** Authentik puts the client ID in the access token's `aud`, so set the server's `VAULT_SYNC_OIDC_AUDIENCE` to the client ID. The server then advertises that client ID to the plugin, and nothing needs to be entered in the plugin besides the server URL. With a provider whose access tokens carry another audience, also set the server's `VAULT_SYNC_OIDC_CLIENT_ID` to the plugin's client ID.
- **Token lifetimes:** any access-token lifetime works, because the plugin refreshes ahead of expiry. The refresh-token lifetime decides how long a device that stays offline remains signed in.
