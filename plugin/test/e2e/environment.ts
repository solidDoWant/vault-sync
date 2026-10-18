// What the `e2e`-tagged Go driver (cmd/vault-sync-server/e2e_test.go) hands
// the specs: the server it started and a token its fake OIDC issuer signed.

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set; run the e2e suite with \`make test-e2e\``);
  return value;
}

export const e2eEnvironment = {
  serverUrl: required("VAULT_SYNC_E2E_SERVER_URL"),
  token: required("VAULT_SYNC_E2E_TOKEN"),
  emulateMobile: process.env.VAULT_SYNC_E2E_MOBILE === "1",
};

/** Plugin ids, as in each plugin's manifest.json. */
export const pluginId = "vault-sync";
export const harnessId = "vault-sync-e2e-harness";
