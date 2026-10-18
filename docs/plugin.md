# Obsidian plugin

This page covers the vault-sync plugin's settings and how it signs in. The server's configuration is in `docs/configuration.md`.

## Settings

Open **Settings → Vault Sync**.

| Setting | Meaning |
|---|---|
| Server URL | The vault-sync server's base URL, for example `https://sync.example.com`. |
| OIDC issuer URL | The issuer your server trusts: the server's `VAULT_SYNC_OIDC_ISSUER_URL`, character for character (including any trailing slash), for example `https://auth.example.com/application/o/vault-sync/` for Authentik. |
| OIDC client ID | The OAuth client the plugin signs in as (see below). The access tokens it receives must carry the server's `VAULT_SYNC_OIDC_AUDIENCE`. |

All three URLs must use `https`. Plain `http` works only for `localhost`, `127.0.0.1` and `::1`, for local development. While you are signed in, these settings are locked, because the stored refresh token belongs to that identity provider. Sign out to change them.

The settings live in the plugin's `data.json` under `.obsidian/plugins/vault-sync/`. That file also holds the refresh token while you are signed in, so treat it as a secret. vault-sync never syncs it.

## Signing in

Click **Sign in** in the settings, or run the **Vault Sync: Sign in** command. The plugin signs in with the OAuth 2.0 Device Authorization Grant (RFC 8628), which works the same on desktop and Android and needs no redirect back into Obsidian. While signed in, **Sign in** is refused: sign out first. A sign-in goes like this:

1. The plugin calls the server's `GetServerInfo` to check that the server speaks a compatible protocol.
2. It discovers the identity provider's endpoints from `<issuer>/.well-known/openid-configuration` and asks for a device code with the scopes `openid offline_access`.
3. A dialog shows a link to the verification page and a user code. Open the page in any browser, on this device or another one, sign in there and enter the code. **Copy code** and **Open page** help on mobile.
4. The plugin polls the identity provider at the interval it asks for, and slows down when told to. Once you approve, it stores the refresh token in plugin data and closes the dialog. Closing the dialog cancels the sign-in and leaves the device as it was (for example still needing a sign-in). If you deny the request or the code expires, the dialog says so. Start again to get a new code.

Access tokens are kept in memory only, never on disk. The plugin refreshes the access token with the refresh token before it expires: a minute before `exp`, or halfway through the token's lifetime if that is shorter. Concurrent requests share one refresh. If the server still refuses a token as unauthenticated (it expired early, or the device clock is off), the plugin refreshes and sends the request once more, unchanged. A retried commit keeps its revision id, so a commit whose first attempt was applied is not duplicated. When the identity provider rotates refresh tokens, the new one is saved before it is used.

### When the session ends

If the identity provider refuses the refresh token (it expired or was revoked, or your session there ended), the plugin forgets it, shows a notice, and its settings show **Sign in again**. Requests to the server fail until you sign in again. Local changes are not lost meanwhile: they stay in the sync journal and on disk, and the next push after you sign in again sends them. A network failure while refreshing does not sign you out. The next request tries again.

**Sign out** forgets both tokens.

The plugin never logs or displays tokens.

## Identity provider setup (Authentik)

Create an OAuth2/OpenID provider and an application for vault-sync:

- **Client type:** public. The plugin cannot keep a client secret.
- **Device code flow:** enabled (in Authentik, the brand's *Device code flow* setting). If the provider's OpenID configuration has no `device_authorization_endpoint`, the plugin reports that the device authorization grant is not supported.
- **Scopes:** include `offline_access`, so that a refresh token is issued. The plugin refuses a sign-in that returns no refresh token.
- **Audience:** Authentik puts the client ID in the access token's `aud`, so set the server's `VAULT_SYNC_OIDC_AUDIENCE` to the client ID, and enter the same client ID in the plugin.
- **Token lifetimes:** any access-token lifetime works, because the plugin refreshes ahead of expiry. The refresh-token lifetime decides how long a device that stays offline remains signed in.
