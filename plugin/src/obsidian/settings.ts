import { Modal, Notice, PluginSettingTab, Setting, type App, type ButtonComponent, type Plugin } from "obsidian";

import type { Vault } from "../gen/vaultsync/v1/types_pb";
import type { AuthState } from "../core/auth/tokens";
import type { ConfigCategory, ConfigSyncSettings } from "../core/config/policy";
import { connectProblem } from "./controller";
import { configSyncSettings, type ConnectedVault, type PluginData } from "./data";
import { DeviceListLoads, DeviceRemovals, type DeviceRow } from "./devices";
import { quotedVaultLabel, vaultLabel } from "./display-text";
import type { EncryptionState } from "./encryption";
import { PassphraseModal, type PassphraseMode } from "./passphrase-modal";
import { errorMessage, statusDescription, statusText, type SyncStatus } from "./status";

/** What the settings tab needs from the plugin. */
export interface SettingsHost extends Plugin {
  readonly data: PluginData;
  readonly authState: AuthState;
  /** True while signed in or while a sign-in runs: the server and identity provider cannot change then. */
  readonly settingsLocked: boolean;
  readonly syncStatus: SyncStatus;
  readonly connectedVault: ConnectedVault | undefined;
  /** Saves `data` after a field changed. */
  saveSettings(): Promise<void>;
  /** Starts the device-flow sign-in; resolves when it finished or was cancelled. */
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;
  listRemoteVaults(): Promise<Vault[]>;
  createRemoteVault(name: string): Promise<Vault>;
  connectVault(vault: Vault, confirmed?: boolean): Promise<"connected" | "needs-confirmation">;
  disconnectVault(): Promise<void>;
  /** The open vault's config folder (`.obsidian` unless renamed). */
  readonly configDir: string;
  /** Stores this device's config sync settings and restarts sync with them. */
  setConfigSync(settings: ConfigSyncSettings): Promise<void>;
  /** The signed-in user's devices (#590). */
  listDevices(): Promise<DeviceRow[]>;
  /** Removes another of the user's devices. */
  removeDevice(deviceId: string): Promise<void>;
  /** Registers this installation again after its device was removed, and starts sync. */
  registerAgain(): Promise<void>;
  /** Whether end-to-end encryption is enabled for the account, and unlocked on this device. */
  encryptionState(): Promise<EncryptionState>;
  /** Enables end-to-end encryption with a new key (or unlocks one another device just created); resolves whether this device created it. */
  enableEncryption(passphrase: string): Promise<boolean>;
  /** Unlocks the account's key on this device. */
  unlockEncryption(passphrase: string): Promise<void>;
}

/** The config sync categories as the settings show them (docs/plugin.md). */
const configCategorySettings: { category: ConfigCategory; name: string; description: (configDir: string) => string }[] = [
  { category: "themes", name: "Themes", description: (dir) => `Installed themes (${dir}/themes) and the appearance settings, including the chosen theme and which snippets are on (${dir}/appearance.json).` },
  { category: "snippets", name: "CSS snippets", description: (dir) => `CSS snippets (${dir}/snippets) and the appearance settings (${dir}/appearance.json).` },
  { category: "hotkeys", name: "Hotkeys", description: (dir) => `Custom hotkeys (${dir}/hotkeys.json).` },
  {
    category: "appSettings",
    name: "Main settings",
    description: (dir) => `The Editor, Files and links and other settings of Obsidian itself (${dir}/app.json), and the property types (${dir}/types.json).`,
  },
  { category: "pluginList", name: "Enabled plugin list", description: (dir) => `Which core and community plugins are on (${dir}/core-plugins.json, ${dir}/community-plugins.json).` },
  {
    category: "corePluginSettings",
    name: "Core plugin settings",
    description: (dir) => `The settings of Obsidian's core plugins, such as daily notes, templates and bookmarks (${dir}/daily-notes.json and so on). The graph view's and the workspaces' files never sync.`,
  },
  {
    category: "plugins",
    name: "Plugin code and data",
    description: (dir) => `Installed community plugins (${dir}/plugins): their code and their settings. Plugin code synced from another device runs on this one. Vault Sync's own folder never syncs.`,
  },
];

const accountDescriptions: Record<AuthState, string> = {
  "signed-out": "Not signed in.",
  "signed-in": "Signed in.",
  "sign-in-required": "Your session ended. Sync is paused until you sign in again; local changes are kept and pushed afterwards.",
};

/**
 * Vault Sync's settings (docs/plugin.md): the server, the identity provider,
 * the account, the remote vault, and the sync status. The server and identity
 * provider cannot be changed while signed in, because the stored refresh
 * token belongs to them (sign out first), nor while a sign-in runs.
 */
export class VaultSyncSettingTab extends PluginSettingTab {
  private statusSetting: Setting | undefined;
  /** Kept across renders, so a list rebuilt while a removal runs cannot send it again. */
  private readonly removals: DeviceRemovals;
  /**
   * The device list on screen: a removal that settles after the tab was
   * rendered again updates this one, not the list it was started from. None
   * while the tab is hidden, so a removal that settles then reloads nothing.
   */
  private shownDevices: { loads: DeviceListLoads; removeButtons: Map<string, ButtonComponent> } | undefined;

  constructor(
    app: App,
    private readonly host: SettingsHost,
  ) {
    super(app, host);
    this.removals = new DeviceRemovals((deviceId) => host.removeDevice(deviceId));
  }

  // display() is the settings API of every Obsidian since 0.9.7; the
  // declarative getSettingDefinitions() needs 1.13, above minAppVersion.
  override display(): void {
    this.render();
  }

  override hide(): void {
    this.closeDevices();
    super.hide();
  }

  /** Rebuilds the tab, e.g. after the account state changed. */
  render(): void {
    const { containerEl, host } = this;
    containerEl.empty();
    this.closeDevices();
    const locked = host.settingsLocked;

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

    // Optional: empty uses what the server advertises. While signed in, the
    // placeholders show the provider in use.
    const provider = host.data.identityProvider;
    new Setting(containerEl).setName("Identity provider").setHeading();
    new Setting(containerEl)
      .setName("OIDC issuer URL")
      .setDesc("Optional. Leave empty to use the issuer the server advertises; needed only for servers that advertise none.")
      .addText((text) =>
        text
          .setPlaceholder(provider?.issuer ?? "From the server")
          .setValue(host.data.oidcIssuer)
          .setDisabled(locked)
          .onChange(async (value) => {
            host.data.oidcIssuer = value;
            await host.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("OIDC client ID")
      .setDesc("Optional. Leave empty to use the client the server advertises, or enter the public OAuth client (with the device code grant enabled) to sign in as instead.")
      .addText((text) =>
        text
          .setPlaceholder(provider?.clientId ?? "From the server")
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
          .setDisabled(locked)
          .onClick(async () => {
            await host.signIn();
            this.render();
          }),
      );
    }
    new Setting(containerEl)
      .setName("Device name")
      .setDesc("How this device is named on the server and in conflict copies. Empty uses the platform's name. Invisible characters are left out and the name is cut at 256 bytes. The server keeps the name the device was first registered with.")
      .addText((text) =>
        text.setValue(host.data.deviceName).onChange(async (value) => {
          host.data.deviceName = value;
          await host.saveSettings();
        }),
      );

    this.renderConfigSync(containerEl);

    if (host.authState === "signed-in") {
      this.renderVault(containerEl);
      this.renderEncryption(containerEl);
      this.renderDevices(containerEl);
    }

    new Setting(containerEl).setName("Sync").setHeading();
    this.statusSetting = new Setting(containerEl).setName("Sync status");
    this.statusSetting.settingEl.addClass("vault-sync-settings-status");
    this.showStatus();
    if (host.syncStatus.state === "device-removed") {
      new Setting(containerEl)
        .setName("Register this device again")
        .setDesc("This device was removed from your account on another device. Registering it again adds it back to your devices and pushes the changes made on it meanwhile.")
        .addButton((button) =>
          button
            .setButtonText("Register again")
            .setCta()
            .onClick(async () => {
              try {
                await host.registerAgain();
              } catch (error) {
                new Notice(`Vault Sync: could not register this device: ${errorMessage(error)}`);
              }
            }),
        );
    }
  }

  /** The user's devices (#590): each with its last activity, and Remove for every one but this device. */
  private renderDevices(containerEl: HTMLElement): void {
    const { host } = this;
    new Setting(containerEl).setName("Devices").setHeading();
    const intro = new Setting(containerEl).setDesc("Loading your devices…");
    const list = containerEl.createDiv({ cls: "vault-sync-devices" });
    const removeButtons = new Map<string, ButtonComponent>();
    const loads = new DeviceListLoads(() => host.listDevices(), {
      rows: (devices) => {
        list.empty();
        removeButtons.clear();
        intro.setDesc(
          "The devices registered to your account. Remove one you no longer use: it stops syncing, and its changes not synced yet stay on it until it is registered again. Each device's history stays. Remove this device from another device.",
        );
        for (const device of devices) {
          const row = new Setting(list).setName(device.label).setDesc(device.description);
          if (device.current) continue;
          row.addButton((button) => {
            removeButtons.set(device.id, button);
            button
              .setButtonText("Remove")
              .setDisabled(this.removals.has(device.id))
              .onClick(() => {
                if (this.removals.has(device.id)) return;
                new ConfirmRemoveDeviceModal(this.app, device, () => {
                  button.setDisabled(true);
                  this.removals.start(device.id).then(
                    (removed) => {
                      if (removed) this.shownDevices?.loads.load();
                    },
                    (error: unknown) => {
                      this.shownDevices?.removeButtons.get(device.id)?.setDisabled(false);
                      new Notice(`Vault Sync: could not remove the device: ${errorMessage(error)}`);
                    },
                  );
                }).open();
              });
          });
        }
      },
      error: (error) => {
        intro.setDesc(`Could not list your devices: ${errorMessage(error)}`);
      },
    });
    this.shownDevices = { loads, removeButtons };
    loads.load();
  }

  /** End-to-end encryption for the account (docs/plugin.md): enable it here, or unlock it on this device. */
  private renderEncryption(containerEl: HTMLElement): void {
    const { host } = this;
    new Setting(containerEl).setName("End-to-end encryption").setHeading();
    const setting = new Setting(containerEl).setName("Encryption key").setDesc("Checking…");
    const open = (mode: PassphraseMode) => {
      new PassphraseModal(this.app, mode, async (passphrase) => {
        if (mode === "unlock") {
          await host.unlockEncryption(passphrase);
          new Notice("Vault Sync: your encryption key is unlocked on this device.");
        } else if (await host.enableEncryption(passphrase)) {
          new Notice("Vault Sync: end-to-end encryption is enabled.");
        } else {
          new Notice("Vault Sync: encryption was already enabled on another device with this passphrase; its key is now unlocked on this device.");
        }
        if (setting.settingEl.isConnected) this.render();
      }).open();
    };
    host.encryptionState().then(
      (state) => {
        if (state === "unlocked") {
          setting.setDesc("Enabled for your account and unlocked on this device. The key is kept only in this device's Vault Sync data, which never syncs.");
        } else if (state === "locked") {
          setting.setDesc("Enabled for your account on another device. Unlock it on this device with your recovery passphrase.");
          setting.addButton((button) =>
            button
              .setButtonText("Unlock")
              .setCta()
              .onClick(() => {
                open("unlock");
              }),
          );
        } else {
          setting.setDesc("Not enabled. Enabling creates your encryption key on this device, protected by a recovery passphrase, for end-to-end encrypted vaults.");
          setting.addButton((button) =>
            button.setButtonText("Enable").onClick(() => {
              open("enable");
            }),
          );
        }
      },
      (error: unknown) => {
        setting.setDesc(`Could not check encryption: ${errorMessage(error)}`);
      },
    );
  }

  /** Stops the device list on screen from loading and painting: the tab was hidden or is rendered again. */
  private closeDevices(): void {
    this.shownDevices?.loads.close();
    this.shownDevices = undefined;
  }

  /** Updates the sync status line in place, so a status change never rebuilds (and clears) the fields being edited. */
  showStatus(): void {
    const status = this.host.syncStatus;
    this.statusSetting?.setName(statusText(status)).setDesc(statusDescription(status));
  }

  /** This device's config folder sync settings for this vault (SPEC.md §8): off by default, with the security warning. */
  private renderConfigSync(containerEl: HTMLElement): void {
    const { host } = this;
    const settings = configSyncSettings(host.data);
    const dir = host.configDir;
    const save = async (next: ConfigSyncSettings) => {
      await host.setConfigSync(next);
      this.render();
    };
    new Setting(containerEl).setName("Config folder sync").setHeading();
    new Setting(containerEl)
      .setName(`Sync the config folder (${dir})`)
      .setDesc(
        `Security risk: settings and plugins synced from other devices, including plugin code, run on this device. Turn this on only for vaults you trust, where you want this folder synced. Applies to this vault on this device only; other devices decide for themselves.`,
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.enabled).onChange(async (enabled) => {
          await save({ ...settings, enabled });
        }),
      );
    if (!settings.enabled) return;
    for (const { category, name, description } of configCategorySettings) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(description(dir))
        .addToggle((toggle) =>
          toggle.setValue(settings.categories[category]).onChange(async (on) => {
            await save({ ...settings, categories: { ...settings.categories, [category]: on } });
          }),
        );
    }
    new Setting(containerEl).setDesc(
      `The layout (${dir}/workspace*.json), the graph view's state (${dir}/graph.json) and Vault Sync's own data never sync. Changes that arrive from other devices take effect after you reload Obsidian; Vault Sync tells you when.`,
    );
  }

  private renderVault(containerEl: HTMLElement): void {
    const { host } = this;
    new Setting(containerEl).setName("Remote vault").setHeading();
    const connected = host.connectedVault;
    if (connected !== undefined) {
      new Setting(containerEl)
        .setName("Connected vault")
        .setDesc(`This vault syncs with ${quotedVaultLabel(connected)}.`)
        .addButton((button) =>
          button.setButtonText("Disconnect").onClick(async () => {
            await host.disconnectVault();
          }),
        );
      return;
    }

    const existing = new Setting(containerEl).setName("Connect to an existing vault").setDesc("Loading your vaults…");
    void host.listRemoteVaults().then(
      (vaults) => {
        const usable = vaults.filter((vault) => connectProblem(vault) === undefined);
        if (usable.length === 0) {
          existing.setDesc("You have no vaults on this server yet. Create one below.");
          return;
        }
        let chosen = usable[0];
        existing.setDesc("Sync this vault with one of your vaults on the server.");
        existing.addDropdown((dropdown) => {
          for (const vault of usable) dropdown.addOption(vault.id, vaultLabel(vault));
          dropdown.onChange((id) => {
            chosen = usable.find((vault) => vault.id === id);
          });
        });
        existing.addButton((button) =>
          button
            .setButtonText("Connect")
            .setCta()
            .onClick(() => {
              if (chosen !== undefined) void this.connect(chosen);
            }),
        );
      },
      (error: unknown) => {
        existing.setDesc(`Could not list your vaults: ${errorMessage(error)}`);
      },
    );

    let name = this.app.vault.getName();
    new Setting(containerEl)
      .setName("Create a vault")
      .setDesc("Create a vault on the server and sync this vault with it.")
      .addText((text) =>
        text.setValue(name).onChange((value) => {
          name = value;
        }),
      )
      .addButton((button) =>
        button.setButtonText("Create and connect").onClick(async () => {
          try {
            await this.connect(await host.createRemoteVault(name));
          } catch (error) {
            new Notice(`Vault Sync: could not create the vault: ${errorMessage(error)}`);
          }
        }),
      );
  }

  private async connect(vault: Vault): Promise<void> {
    try {
      if ((await this.host.connectVault(vault)) === "needs-confirmation") {
        new ConfirmConnectModal(this.app, quotedVaultLabel(vault), () => {
          void this.host.connectVault(vault, true).catch((error: unknown) => new Notice(`Vault Sync: could not connect: ${errorMessage(error)}`));
        }).open();
      }
    } catch (error) {
      new Notice(`Vault Sync: could not connect: ${errorMessage(error)}`);
    }
  }
}

/** The confirmation before another device is removed (#590). */
class ConfirmRemoveDeviceModal extends Modal {
  constructor(
    app: App,
    private readonly device: DeviceRow,
    private readonly onConfirm: () => void,
  ) {
    super(app);
    this.titleEl.setText("Remove this device?");
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: `${this.device.label} will stop syncing. Its files and any changes it has not synced yet stay on it, and are synced if it is registered again there. Its history on the server stays. This cannot be undone from here.`,
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) => {
        button.setButtonText("Remove device").onClick(() => {
          this.close();
          this.onConfirm();
        });
        // What setWarning does; its replacement, setDestructive, needs Obsidian 1.13, above minAppVersion.
        button.buttonEl.addClass("mod-warning");
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** The warning before a non-empty vault is connected to a non-empty remote vault. */
class ConfirmConnectModal extends Modal {
  constructor(
    app: App,
    /** The remote vault, as quotedVaultLabel shows it. */
    private readonly vaultLabel: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
    this.titleEl.setText("Connect a vault that has files?");
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: `Both this vault and ${this.vaultLabel} on the server already have files. They will be combined: files only one side has are copied to the other, and nothing is deleted or overwritten. Where both have a file at the same path with different content, the server's version is kept at that path and this vault's version is kept next to it as a conflict copy.`,
      cls: "vault-sync-connect-warning",
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Connect and combine")
          .setCta()
          .onClick(() => {
            this.close();
            this.onConfirm();
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
