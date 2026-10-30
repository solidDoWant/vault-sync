# Identity provider

For: admins. You run an OIDC sign-in provider, such as Authentik, and you set the server's sign-in settings.

The plugin signs users in through your OIDC provider. The server then accepts the provider's access tokens. This page says what the provider must offer, gives a worked example for Authentik, and has notes for other providers. The variables are in [Sign-in (OIDC)](configuration-reference.md#sign-in-oidc).

## What the provider must offer

The plugin signs in with the OAuth 2.0 device authorization grant (RFC 8628). In this flow, the plugin shows a link and a short code. The user opens the link in any browser, signs in and enters the code. The flow works the same on desktop and Android, and it needs no redirect back into Obsidian.

The provider must offer the following:

- A public client. The plugin cannot keep a client secret.
- The device authorization grant. The provider's discovery document (`<issuer>/.well-known/openid-configuration`) must name a `device_authorization_endpoint`. If it does not, the plugin reports that the device authorization grant is not supported.
- A refresh token. The plugin asks for the scopes `openid offline_access`. It refuses a sign-in that returns no refresh token.
- Access tokens that are JWTs, signed with RS256, ES256 or EdDSA by a key in the provider's key set. The server refuses `none` and all HMAC algorithms.
- `https` for the issuer, the discovery document, every endpoint and the key set (`jwks_uri`). Plain `http` works only for a loopback issuer (`localhost`, `127.0.0.1`, `::1`) in local development, and then only to loopback hosts.
- A discovery document whose `issuer` is exactly the issuer URL that you configure.
- Responses of at most 64 KiB to the plugin.

The plugin polls the provider at the interval that the provider asks for. It waits 5 seconds longer each time the provider answers `slow_down`.

### The claims in the access token

The server accepts an access token only if all of these are true:

- `iss` equals `VAULT_SYNC_OIDC_ISSUER_URL` exactly, including any trailing slash.
- `aud` contains `VAULT_SYNC_OIDC_AUDIENCE`.
- `sub` is present, at most 255 bytes, and has no control characters.
- `exp` is present and not in the past. The server allows no clock skew on `exp`.
- `nbf`, if present, is at most one minute in the future.

The server identifies a user by the issuer and `sub` together. It creates the user at the first request that carries a valid token. So if you change the issuer, every user becomes a new user.

If the token has a `name` claim, or else a `preferred_username` claim, vault-sync uses it as the user's name. The history shows that name, and the plugin puts it in the names of conflict copies. Without either claim, conflict copies use `user`.

### Where the server gets the signing keys

The server reads the key set from the `jwks_uri` in the discovery document. The `jwks_uri` can be on another host than the issuer. The server fetches the keys at the first request that needs them, not at startup. So the server starts even when the provider is down.

When the provider rotates its keys, the server accepts a new key at most 30 seconds after its previous fetch. If a fetch fails, the server keeps the keys it already has.

The server follows a redirect only to the same host and port, and never from `https` to `http`. It follows at most 5 redirects. If your provider redirects the discovery document or the keys to another host, configure the final issuer URL instead.

For more detail on how the server checks tokens, see [Sign-in tokens](security.md#sign-in-tokens).

## Example: Authentik

In Authentik, vault-sync needs a public OAuth2/OpenID provider with the device code flow, and an application for that provider.

1. Turn on the device code flow. Go to *System → Brands*, edit your brand, and set *Default flows → Device code flow*, for example to the default authorization flow. Without it, the provider's OpenID configuration has no `device_authorization_endpoint`.
2. Create the provider. Go to *Applications → Providers* and create an *OAuth2/OpenID Provider*. Set the client type to *Public*. Among the scopes, select the `offline_access` mapping, so that Authentik issues a refresh token. You do not need redirect URIs, because the device flow does not use them.
3. Choose the token lifetimes on the provider. Any access-token lifetime works, because the plugin gets a new access token before the old one expires. The refresh-token lifetime decides how long a device that stays offline remains signed in.
4. Create the application. Go to *Applications → Applications* and create an application for the provider, with the slug `vault-sync`. Bind the users or groups that can sync.

Then set the chart values:

- Set `config.oidc.issuerUrl` to the provider's issuer, for example `https://auth.example.com/application/o/vault-sync/`. The trailing slash matters, because the `iss` of each token must equal it exactly.
- Set `config.oidc.audience` to the provider's client ID. Authentik puts the client ID in the `aud` of the access token.
- Leave `config.oidc.clientId` empty. Then the chart leaves `VAULT_SYNC_OIDC_CLIENT_ID` unset, and the plugin signs in as the audience. Set it only if the plugin must sign in as another client.

These values set `VAULT_SYNC_OIDC_ISSUER_URL`, `VAULT_SYNC_OIDC_AUDIENCE` and `VAULT_SYNC_OIDC_CLIENT_ID`. See [Chart values](chart-values.md).

Users enter only the server URL in the plugin. The server tells the plugin the issuer and the client ID. The plugin has optional settings for both in its *Advanced* group. A user needs them only for a server too old to advertise them, or to pin the issuer.

## Other OIDC providers

The steps are the same for any provider that meets the requirements above. Look for these differences:

- Some providers put an API audience in the access token, not the client ID. Then set `VAULT_SYNC_OIDC_AUDIENCE` to that audience, and set `VAULT_SYNC_OIDC_CLIENT_ID` to the plugin's client ID. The tokens that this client gets must carry the audience.
- The server shows the client ID to anyone who can reach it. So the client must be public. Never use a confidential client, and never put a secret in `VAULT_SYNC_OIDC_CLIENT_ID`.
- The client ID must be 1 to 255 printable ASCII characters. If `VAULT_SYNC_OIDC_CLIENT_ID` is unset and the audience does not meet this rule, the server advertises no client ID. Then each user must enter the client ID in the plugin.
- Some providers give opaque access tokens by default, not JWTs. The server cannot check an opaque token, so configure the provider to issue JWT access tokens.
