import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";

import type { AuthState } from "../core/auth/tokens";
import type { PluginData } from "./data";

/** What the settings tab needs from the plugin. */
export interface SettingsHost extends Plugin {
  readonly data: PluginData;
  readonly authState: AuthState;
  /** Saves `data` after a field changed. */
  saveSettings(): Promise<void>;
  /** Starts the device-flow sign-in; resolves when it finished or was cancelled. */
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;
}

const accountDescriptions: Record<AuthState, string> = {
  "signed-out": "Not signed in.",
  "signed-in": "Signed in.",
  "sign-in-required": "Your session ended. Sync is paused until you sign in again; local changes are kept and pushed afterwards.",
};

/**
 * Vault Sync's settings (docs/plugin.md): the server, the identity provider,
 * and the account. The server and identity provider cannot be changed while
 * signed in, because the stored refresh token belongs to them; sign out first.
 */
export class VaultSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost,
  ) {
    super(app, host);
  }

  // display() is the settings API of every Obsidian since 0.9.7; the
  // declarative getSettingDefinitions() needs 1.13, above minAppVersion.
  override display(): void {
    this.render();
  }

  /** Rebuilds the tab, e.g. after the account state changed. */
  render(): void {
    const { containerEl, host } = this;
    containerEl.empty();
    const locked = host.authState === "signed-in";

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("The vault-sync server, e.g. https://sync.example.com.")
      .addText((text) =>
        text
          .setPlaceholder("https://sync.example.com")
          .setValue(host.data.serverUrl)
          .setDisabled(locked)
          .onChange(async (value) => {
            host.data.serverUrl = value;
            await host.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Identity provider").setHeading();
    new Setting(containerEl)
      .setName("OIDC issuer URL")
      .setDesc("The issuer your server trusts, e.g. https://auth.example.com/application/o/vault-sync/.")
      .addText((text) =>
        text
          .setPlaceholder("https://auth.example.com/application/o/vault-sync/")
          .setValue(host.data.oidcIssuer)
          .setDisabled(locked)
          .onChange(async (value) => {
            host.data.oidcIssuer = value;
            await host.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("OIDC client ID")
      .setDesc("The public OAuth client with the device code grant enabled.")
      .addText((text) =>
        text
          .setValue(host.data.oidcClientId)
          .setDisabled(locked)
          .onChange(async (value) => {
            host.data.oidcClientId = value;
            await host.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Account").setHeading();
    const account = new Setting(containerEl).setName("Status").setDesc(accountDescriptions[host.authState]);
    if (host.authState === "signed-in") {
      account.addButton((button) =>
        button.setButtonText("Sign out").onClick(async () => {
          await host.signOut();
          this.render();
        }),
      );
    } else {
      account.addButton((button) =>
        button
          .setButtonText(host.authState === "sign-in-required" ? "Sign in again" : "Sign in")
          .setCta()
          .onClick(async () => {
            await host.signIn();
            this.render();
          }),
      );
    }
  }
}
