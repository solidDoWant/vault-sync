import { Modal, Notice, PluginSettingTab, Setting, type App, type ButtonComponent, type Plugin, type TextComponent, type ToggleComponent } from "obsidian";

import { VaultRole, type Vault } from "../gen/vaultsync/v1/types_pb";
import type { AuthState } from "../core/auth/tokens";
import type { ConversionMember } from "../core/keys/convert-vault";
import type { EscrowChange, EscrowOffer } from "../core/keys/encrypted-vault";
import type { RekeyResult } from "../core/sync/rekey";
import { connectProblem } from "./controller";
import { type ConnectedVault, type PluginData } from "./data";
import { deviceNameOf, deviceNameProblem } from "./device-name";
import { DeviceListLoads, DeviceRemovals, type DeviceRow } from "./devices";
import { obsidianSyncEnabled } from "./obsidian-sync";
import { quotedVaultLabel, vaultLabel } from "./display-text";
import { conversionConfirmable, conversionMemberText, deleteConfirmed, escrowKeyFingerprint, memberKeyText, membershipErrorMessage, newVaultEscrowText, vaultExit, parseInvitationDays, vaultKeysText, roleDescription, roleName, roles, type CreatedInvitation, type MemberRow, type Sharing } from "./sharing";
import type { EncryptionState } from "./encryption";
import { ESCROW_CHANGE_STATUS, EscrowResetModal } from "./escrow-reset-modal";
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
  /** Creates a vault: plaintext, or end-to-end encrypted (with or without escrow) when `encryption` is given. */
  createRemoteVault(name: string, encryption?: { escrow: boolean }): Promise<Vault>;
  /** The server's escrow key and default, for a new encrypted vault. */
  escrowOffer(): Promise<EscrowOffer>;
  /** The user accepted an escrow change in the escrow reset prompt. */
  acceptEscrowChange(change: EscrowChange): Promise<void>;
  /** The user declined an escrow change; escrow keeps the pinned key. */
  declineEscrowChange(change: EscrowChange): Promise<void>;
  connectVault(vault: Vault, confirmed?: boolean): Promise<"connected" | "needs-confirmation">;
  disconnectVault(): Promise<void>;
  /** The signed-in user's devices (#590). */
  listDevices(): Promise<DeviceRow[]>;
  /** Removes another of the user's devices. */
  removeDevice(deviceId: string): Promise<void>;
  /** The Device name setting was edited (and saved); `before` is its value before the edit. Renames this device once the edits settle. */
  deviceNameChanged(before: string): void;
  /** The name this device uses when the Device name setting is empty: the platform's name. */
  readonly defaultDeviceName: string;
  /** Registers this installation again after its device was removed, and starts sync. */
  registerAgain(): Promise<void>;
  /** The connected vault's Sharing section (#34). */
  loadSharing(): Promise<Sharing>;
  /** Creates an invitation to the connected vault, redeemable for `days` days (the server's default when undefined). */
  createInvitation(role: VaultRole, days: number | undefined): Promise<CreatedInvitation>;
  revokeInvitation(invitationId: string): Promise<void>;
  setMemberRole(userId: string, role: VaultRole): Promise<void>;
  removeMember(userId: string): Promise<void>;
  /** Rotates the connected encrypted vault's key (owners only): the next epoch, for every current member. */
  rotateVaultKey(): Promise<void>;
  /** The connected plaintext vault's members with the fingerprints of the keys the server reports, to compare before converting (owners only). */
  conversionMembers(): Promise<ConversionMember[]>;
  /** Converts the connected plaintext vault to end-to-end encryption with the fingerprints the owner compared (owners only). */
  convertVault(compared: readonly ConversionMember[], escrow: boolean): Promise<void>;
  /** Re-encrypts the connected encrypted vault's history under its current key and retires the old keys (owners only). */
  reencryptHistory(): Promise<RekeyResult>;
  /** Leaves the connected vault; sync then stops with "no longer a member" and the files stay. */
  leaveVault(): Promise<void>;
  /** Deletes the connected vault on the server (owners only); sync then stops with "vault deleted" and the files stay. */
  deleteVault(): Promise<void>;
  /** Redeems an invite code and resolves with the vault joined. */
  joinVault(code: string): Promise<Vault>;
  /** Whether end-to-end encryption is enabled for the account, and unlocked on this device. */
  encryptionState(): Promise<EncryptionState>;
  /** Enables end-to-end encryption with a new key (or unlocks one another device just created); resolves whether this device created it. */
  enableEncryption(passphrase: string): Promise<boolean>;
  /** Unlocks the account's key on this device. */
  unlockEncryption(passphrase: string): Promise<void>;
  /** Changes the account's recovery passphrase; the key pair stays the same. */
  changePassphrase(current: string, next: string): Promise<void>;
}

const accountDescriptions: Record<AuthState, string> = {
  "signed-out": "Not signed in.",
  "signed-in": "Signed in.",
  "sign-in-required": "Your session ended. Sign in again to resume syncing. Your changes are kept.",
};

/**
 * Vault Sync's settings (docs/plugin.md): the sync status, the server, the
 * account, encryption, the remote vault, sharing and devices, then the
 * Advanced group (identity provider, vault key actions). The server and identity
 * provider cannot be changed while signed in, because the stored refresh
 * token belongs to them (sign out first), nor while a sign-in runs.
 */
export class VaultSyncSettingTab extends PluginSettingTab {
  private statusSetting: Setting | undefined;
  private deviceNameText: TextComponent | undefined;
  private showDeviceNameProblem: ((problem: string | undefined) => void) | undefined;
  /** The new escrow key whose prompt this tab opened by itself, so that two sections showing the change open it once. */
  private promptedEscrowKey: string | undefined;
  /** Kept across renders, so a list rebuilt while a removal runs cannot send it again. */
  private readonly removals: DeviceRemovals;
  /**
   * The device list on screen: a removal that settles after the tab was
   * rendered again updates this one, not the list it was started from. None
   * while the tab is hidden, so a removal that settles then reloads nothing.
   */
  private shownDevices: { loads: DeviceListLoads; removeButtons: Map<string, ButtonComponent> } | undefined;
  /** Bumped by every render, hide and Sharing load, so only the latest load paints the Sharing section, and none once the tab is hidden. */
  private sharingLoads = 0;
  /** The Advanced group on screen. */
  private advancedEl: HTMLDetailsElement | undefined;
  /** The Re-encrypt history row on screen, in the Advanced group. */
  private reencryptEl: HTMLElement | undefined;
  /** A notice asked to show Re-encrypt history: scroll to it once it is painted. */
  private revealReencrypt = false;

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
    this.sharingLoads++;
    super.hide();
  }

  /**
   * Rebuilds the tab, e.g. after the account state changed. The sections
   * follow the setup flow, with the sync status (and what recovers from its
   * errors) first; settings few users need sit in the collapsed Advanced
   * group at the bottom.
   */
  render(): void {
    const { containerEl, host } = this;
    containerEl.empty();
    this.closeDevices();
    this.sharingLoads++;
    this.reencryptEl = undefined;
    const locked = host.settingsLocked;

    new Setting(containerEl).setName("Sync").setHeading();
    this.statusSetting = new Setting(containerEl).setName("Sync status");
    this.statusSetting.settingEl.addClass("vault-sync-settings-status");
    this.showStatus();
    if (obsidianSyncEnabled(this.app)) {
      new Setting(containerEl)
        .setName("Obsidian Sync is also on")
        .setDesc(
          "This vault also syncs with Obsidian Sync. With two sync services, every change is uploaded twice, and you can get extra conflict copies. Use only one. To stop it, open Settings → Sync and disconnect from the remote vault, or turn off Sync in Settings → Core plugins.",
        )
        .settingEl.addClass("vault-sync-obsidian-sync-warning");
    }
    if (host.syncStatus.state === "device-removed") {
      new Setting(containerEl)
        .setName("Register this device again")
        .setDesc("Another device removed this one from your account. Register it again to resume syncing. Changes made here are kept and synced.")
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

    new Setting(containerEl).setName("Server").setHeading();
    const serverUrl = new Setting(containerEl)
      .setName("Server URL")
      .setDesc("The address of your vault-sync server, for example https://sync.example.com.")
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
    serverUrl.settingEl.addClass("vault-sync-server-url");

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
    const deviceName = new Setting(containerEl).setName("Device name").setDesc("The name of this device in your device list, in history and in conflict copies.");
    const deviceNameError = deviceName.descEl.createDiv({ cls: "vault-sync-field-error" });
    deviceName.addText((text) => {
      this.deviceNameText = text;
      // An invalid name is not saved: the error stays under the field until it is fixed.
      const showProblem = (problem: string | undefined) => {
        deviceNameError.setText(problem ?? "");
        text.inputEl.toggleClass("vault-sync-field-invalid", problem !== undefined);
        text.inputEl.setAttribute("aria-invalid", String(problem !== undefined));
      };
      this.showDeviceNameProblem = showProblem;
      text
        .setPlaceholder(host.defaultDeviceName)
        .setValue(this.shownDeviceName())
        .onChange(async (value) => {
          const problem = deviceNameProblem(value);
          showProblem(problem);
          if (problem !== undefined) return;
          const before = host.data.deviceName;
          host.data.deviceName = value;
          await host.saveSettings();
          host.deviceNameChanged(before);
        });
    });

    // The connected vault's owner actions in the Advanced group, filled in once the Sharing section loads.
    const vaultActions = createDiv({ cls: "vault-sync-vault-actions" });
    if (host.authState === "signed-in") {
      // One request for both sections that show it.
      const encryption = host.encryptionState();
      this.renderEncryption(containerEl, encryption);
      this.renderVault(containerEl, encryption);
      if (host.connectedVault !== undefined) this.renderSharing(containerEl, vaultActions);
      this.renderDevices(containerEl);
    }

    this.renderAdvanced(containerEl, vaultActions, locked);
  }

  /**
   * The Advanced group, collapsed unless the user left it open on this
   * device: the identity provider overrides, and the connected vault's
   * owner actions in `vaultActions`. Nothing needed to recover from an
   * error is in it.
   */
  private renderAdvanced(containerEl: HTMLElement, vaultActions: HTMLElement, locked: boolean): void {
    const { host } = this;
    const advanced = containerEl.createEl("details", { cls: "vault-sync-advanced" });
    advanced.open = host.data.advancedSettingsOpen === true;
    advanced.createEl("summary", { cls: "vault-sync-advanced-summary", text: "Advanced" });
    advanced.addEventListener("toggle", () => {
      if (advanced.open === (host.data.advancedSettingsOpen === true)) return;
      if (advanced.open) host.data.advancedSettingsOpen = true;
      else delete host.data.advancedSettingsOpen;
      void host.saveSettings();
    });
    this.advancedEl = advanced;

    // Optional: empty uses what the server advertises. While signed in, the
    // placeholders show the provider in use.
    const provider = host.data.identityProvider;
    new Setting(advanced).setName("Identity provider").setHeading();
    new Setting(advanced)
      .setName("OIDC issuer URL")
      .setDesc("Leave empty to use the server's identity provider. Set it only if the server does not provide one.")
      .addText((text) =>
        text
          .setPlaceholder(provider?.issuer ?? "From the server")
          .setValue(host.data.oidcIssuer)
          .setDisabled(locked)
          .onChange(async (value) => {
            host.data.oidcIssuer = value;
            await host.saveSettings();
          }),
      )
      .settingEl.addClass("vault-sync-oidc-issuer");
    new Setting(advanced)
      .setName("OIDC client ID")
      .setDesc("Leave empty to use the server's client. To use a different client, enter a public client ID that allows the device code grant.")
      .addText((text) =>
        text
          .setPlaceholder(provider?.clientId ?? "From the server")
          .setValue(host.data.oidcClientId)
          .setDisabled(locked)
          .onChange(async (value) => {
            host.data.oidcClientId = value;
            await host.saveSettings();
          }),
      )
      .settingEl.addClass("vault-sync-oidc-client-id");

    advanced.appendChild(vaultActions);
  }

  /**
   * Opens the Advanced group and scrolls to Re-encrypt history, opening the
   * settings tab first when it is closed: for a notice that tells the user
   * to run it.
   */
  private showReencryptHistory(): void {
    const { host } = this;
    if (host.data.advancedSettingsOpen !== true) {
      host.data.advancedSettingsOpen = true;
      void host.saveSettings();
    }
    this.revealReencrypt = true;
    if (this.advancedEl?.isConnected === true) {
      this.advancedEl.open = true;
      this.scrollToReencrypt();
      return;
    }
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(host.manifest.id);
  }

  /** Scrolls to Re-encrypt history if a notice asked for it and it is shown. */
  private scrollToReencrypt(): void {
    if (!this.revealReencrypt || this.reencryptEl?.isConnected !== true) return;
    this.revealReencrypt = false;
    this.reencryptEl.scrollIntoView({ block: "center" });
  }

  /** Shows the Device name setting as it is now, e.g. after a refused rename put it back. */
  showDeviceName(): void {
    this.deviceNameText?.setValue(this.shownDeviceName());
    this.showDeviceNameProblem?.(undefined);
  }

  /** The name this device goes by, so the field is never blank: the setting, or the platform's name when it is empty. */
  private shownDeviceName(): string {
    return deviceNameOf(this.host.data.deviceName, this.host.defaultDeviceName);
  }

  /** Lists the devices again, if the list is shown: after this device was renamed. */
  reloadDevices(): void {
    this.shownDevices?.loads.load();
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
          "The devices on your account. A removed device stops syncing and keeps its files. To remove this device, use another device.",
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
  private renderEncryption(containerEl: HTMLElement, encryption: Promise<EncryptionState>): void {
    const { host } = this;
    new Setting(containerEl).setName("End-to-end encryption").setHeading();
    const setting = new Setting(containerEl).setName("Encryption key").setDesc("Checking…");
    const open = (mode: PassphraseMode) => {
      new PassphraseModal(this.app, mode, async (passphrase, newPassphrase) => {
        if (mode === "change") {
          await host.changePassphrase(passphrase, newPassphrase);
          new Notice("Vault Sync: the recovery passphrase is changed. Use the new one on other devices.");
        } else if (mode === "unlock") {
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
    encryption.then(
      (state) => {
        if (state === "unlocked") {
          setting.setDesc("On, and unlocked on this device. Your key stays on this device and is never synced.");
          setting.addButton((button) =>
            button.setButtonText("Change passphrase").onClick(() => {
              open("change");
            }),
          );
        } else if (state === "locked" || state === "key-changed") {
          setting.setDesc(
            state === "locked"
              ? "On for your account. Enter your recovery passphrase to unlock it on this device."
              : "Locked. Your account's key changed on the server. Enter its recovery passphrase to unlock it.",
          );
          setting.addButton((button) =>
            button
              .setButtonText("Unlock")
              .setCta()
              .onClick(() => {
                open("unlock");
              }),
          );
        } else {
          setting.setDesc("Off. Turn it on to use encrypted vaults. A recovery passphrase protects your key.");
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

  /**
   * The connected vault's members and invitations (#34). Owners manage them;
   * editors and viewers see their role and can leave. Every change is sent
   * and then the section is read again from the server, so a refused change
   * shows the state the server kept.
   */
  private renderSharing(containerEl: HTMLElement, vaultActions: HTMLElement): void {
    const { host } = this;
    new Setting(containerEl).setName("Sharing").setHeading();
    const intro = new Setting(containerEl).setDesc("Loading the vault's members…");
    const section = containerEl.createDiv({ cls: "vault-sync-sharing" });
    const load = () => {
      const generation = ++this.sharingLoads;
      void host.loadSharing().then(
        (sharing) => {
          if (generation !== this.sharingLoads) return;
          section.empty();
          vaultActions.empty();
          this.paintSharing(intro, section, vaultActions, sharing, load);
        },
        (error: unknown) => {
          if (generation !== this.sharingLoads) return;
          intro.setDesc(`Could not load the vault's members: ${errorMessage(error)}`);
        },
      );
    };
    load();
  }

  /** Paints a loaded Sharing section; an owner's key actions on an encrypted vault go to `vaultActions`, in the Advanced group. */
  private paintSharing(intro: Setting, section: HTMLElement, vaultActions: HTMLElement, sharing: Sharing, reload: () => void): void {
    const { host } = this;
    /** Runs a membership change, then reads the section again; a refusal is a notice. */
    const change = (what: string, run: () => Promise<void>) => {
      run().then(reload, (error: unknown) => {
        new Notice(`Vault Sync: could not ${what}: ${membershipErrorMessage(error)}`);
        reload();
      });
    };
    if (sharing.kind === "not-member") {
      intro.setDesc(
        host.syncStatus.state === "vault-deleted"
          ? "An owner deleted this vault, so it cannot sync. Disconnect it above. Your files stay here."
          : "You are no longer a member of this vault, so it cannot sync. Disconnect it above. Your files stay here.",
      );
      return;
    }
    const role = sharing.kind === "owner" ? VaultRole.OWNER : sharing.role;
    intro.setDesc(`Your role: ${roleName(role)}. ${roleDescription(role)}`);
    intro.settingEl.addClass("vault-sync-sharing-role");
    if (sharing.keys !== undefined) {
      new Setting(section).setName("Fingerprints").setDesc(vaultKeysText(sharing.keys)).settingEl.addClass("vault-sync-fingerprint");
    }
    if (sharing.kind === "owner" && sharing.keys?.kind === "verified" && sharing.keys.escrow !== undefined) {
      void host.escrowOffer().then(
        (offer) => {
          if (offer.change !== undefined) this.showEscrowChange(new Setting(section).setName("Escrow"), offer.change);
        },
        () => undefined,
      );
    }
    if (sharing.kind === "owner") {
      new Setting(section).setName("Members").setHeading();
      const members = section.createDiv({ cls: "vault-sync-members" });
      for (const member of sharing.members) {
        const row = new Setting(members).setName(member.label).setDesc(member.description);
        const keyText = memberKeyText(member, sharing.keys);
        if (keyText !== undefined) row.descEl.createDiv({ cls: "vault-sync-fingerprint", text: keyText });
        row
          .addDropdown((dropdown) => {
            for (const option of roles) dropdown.addOption(String(option), roleName(option));
            dropdown.setValue(String(member.role)).onChange((value) => {
              const next = roles.find((option) => String(option) === value);
              if (next === undefined) return;
              new ConfirmModal(this.app, {
                title: "Change this member's role?",
                text: `${member.label} becomes ${roleName(next).toLowerCase()}. ${roleDescription(next)}`,
                confirm: "Change role",
                onConfirm: () => {
                  change("change the role", () => host.setMemberRole(member.userId, next));
                },
                onCancel: reload,
              }).open();
            });
          })
          .addButton((button) => {
            button.setButtonText("Remove").onClick(() => {
              new ConfirmModal(this.app, {
                title: "Remove this member?",
                text: removeMemberText(member),
                confirm: "Remove member",
                warning: true,
                onConfirm: () => {
                  change("remove the member", () => host.removeMember(member.userId));
                },
              }).open();
            });
          });
      }

      const connected = host.connectedVault;
      if (sharing.encrypted && connected !== undefined) {
        new Setting(vaultActions).setName(`Vault ${quotedVaultLabel(connected)}`).setHeading();
        new Setting(vaultActions)
          .setName("Rotate key")
          .setDesc("Give all members a new vault key for new changes. Removing a member does this automatically.")
          .addButton((button) => {
            button.setButtonText("Rotate key").onClick(() => {
              new ConfirmModal(this.app, {
                title: "Rotate the vault key?",
                text: "Every current member and pending invitation gets the new key. Notes already synced stay encrypted with the keys they were written with.",
                confirm: "Rotate key",
                onConfirm: () => {
                  button.setDisabled(true);
                  host.rotateVaultKey().then(
                    () => {
                      new Notice("Vault Sync: the vault key was rotated.");
                      reload();
                    },
                    (error: unknown) => {
                      new Notice(`Vault Sync: could not rotate the vault key: ${membershipErrorMessage(error)}`);
                      reload();
                    },
                  );
                },
              }).open();
            });
          });
        const reencrypt = new Setting(vaultActions)
          .setName("Re-encrypt history")
          .setDesc("Encrypt old versions of notes with the current key and retire older keys. Run it after you remove a member or turn off escrow. Sync keeps running.")
          .addButton((button) => {
            button.setButtonText("Re-encrypt history").onClick(() => {
              button.setDisabled(true);
              host.reencryptHistory().then(
                (result) => {
                  new Notice(`Vault Sync: history re-encrypted (${String(result.moved)} versions moved to the current key).`);
                  reload();
                },
                (error: unknown) => {
                  new Notice(`Vault Sync: could not re-encrypt the history: ${errorMessage(error)}`);
                  reload();
                },
              );
            });
          });
        this.reencryptEl = reencrypt.settingEl;
        this.scrollToReencrypt();
      }

      if (!sharing.encrypted) {
        new Setting(section)
          .setName("Convert to end-to-end encryption")
          .setDesc("Encrypt this vault and keep its members, notes and history. First, every member must turn on encryption, and you must revoke pending invitations.")
          .addButton((button) => {
            button.setButtonText("Convert…").onClick(() => {
              new ConvertVaultModal(this.app, host, () => {
                const message = createFragment((fragment) => {
                  fragment.appendText("Vault Sync: the vault is now end-to-end encrypted. Run Re-encrypt history (under Advanced) to encrypt its earlier versions. ");
                  fragment.createEl("button", { text: "Show Re-encrypt history" }).addEventListener("click", () => {
                    this.showReencryptHistory();
                  });
                });
                new Notice(message, 0);
                reload();
              }).open();
            });
          });
      }

      new Setting(section).setName("Invitations").setHeading();
      const invitations = section.createDiv({ cls: "vault-sync-invitations" });
      if (sharing.invitations.length === 0) new Setting(invitations).setDesc("No pending invitations.");
      for (const invitation of sharing.invitations) {
        new Setting(invitations)
          .setName(invitation.label)
          .setDesc(invitation.description)
          .addButton((button) =>
            button.setButtonText("Revoke").onClick(() => {
              button.setDisabled(true);
              change("revoke the invitation", () => host.revokeInvitation(invitation.id));
            }),
          );
      }
      let inviteRole = VaultRole.EDITOR;
      let days = "";
      new Setting(section.createDiv({ cls: "vault-sync-invite" }))
        .setName("Invite someone")
        .setDesc("Create a one-time invite code for the chosen role. Anyone with the code can join. It expires after 7 days, or after the days you set (30 at most).")
        .addDropdown((dropdown) => {
          for (const option of roles) dropdown.addOption(String(option), roleName(option));
          dropdown.setValue(String(inviteRole)).onChange((value) => {
            inviteRole = roles.find((option) => String(option) === value) ?? inviteRole;
          });
        })
        .addText((text) =>
          text.setPlaceholder("Days").onChange((value) => {
            days = value;
          }),
        )
        .addButton((button) =>
          button
            .setButtonText("Create invitation")
            .setCta()
            .onClick(async () => {
              let parsed: number | undefined;
              try {
                parsed = parseInvitationDays(days);
              } catch (error) {
                new Notice(`Vault Sync: ${errorMessage(error)}`);
                return;
              }
              button.setDisabled(true);
              try {
                const created = await host.createInvitation(inviteRole, parsed);
                new InviteCodeModal(this.app, created).open();
              } catch (error) {
                new Notice(`Vault Sync: could not create the invitation: ${membershipErrorMessage(error)}`);
              } finally {
                button.setDisabled(false);
                reload();
              }
            }),
        );
    }
    const vaultName = host.connectedVault?.name ?? "";
    // Delete needs the vault's name to confirm; without it the last owner sees Leave, which the server refuses with its reason.
    if (vaultExit(sharing) === "delete" && vaultName !== "") {
      new Setting(section)
        .setName("Delete vault")
        .setDesc(
          "You are the only owner, so you cannot leave this vault. To leave, make another member an owner first. Delete removes the vault for all members: their devices stop syncing and keep their files. Only the server operator can restore it, within 30 days.",
        )
        .addButton((button) => {
          button.setButtonText("Delete vault").onClick(() => {
            new ConfirmModal(this.app, {
              title: "Delete this vault?",
              text: `Every member loses access and every device stops syncing; the files on the devices stay. Type the vault's name, ${vaultName}, to confirm.`,
              confirm: "Delete vault",
              warning: true,
              typeToConfirm: vaultName,
              onConfirm: () => {
                host.deleteVault().then(
                  () => {
                    this.render();
                  },
                  (error: unknown) => {
                    new Notice(`Vault Sync: could not delete the vault: ${membershipErrorMessage(error)}`);
                  },
                );
              },
            }).open();
          });
          button.buttonEl.addClass("mod-warning");
        });
      return;
    }
    new Setting(section)
      .setName("Leave vault")
      .setDesc("Leave this vault and stop syncing it. Your files stay here. To rejoin, you need a new invitation.")
      .addButton((button) => {
        button.setButtonText("Leave vault").onClick(() => {
          new ConfirmModal(this.app, {
            title: "Leave this vault?",
            text: "You stop being a member and this vault stops syncing. The files stay in this vault. To join again you need a new invitation from an owner.",
            confirm: "Leave vault",
            warning: true,
            onConfirm: () => {
              host.leaveVault().then(
                () => {
                  this.render();
                },
                (error: unknown) => {
                  new Notice(`Vault Sync: could not leave the vault: ${membershipErrorMessage(error)}`);
                },
              );
            },
          }).open();
        });
        button.buttonEl.addClass("mod-warning");
      });
  }

  private renderVault(containerEl: HTMLElement, encryption: Promise<EncryptionState>): void {
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

    let code = "";
    const join = new Setting(containerEl.createDiv({ cls: "vault-sync-join" }))
      .setName("Join with an invite code")
      .setDesc("Paste an invite code to sync this vault with a shared vault. To keep your own notes separate, join from a new Obsidian vault.")
      .addText((text) => {
        text.setPlaceholder("Invite code").onChange((value) => {
          code = value;
        });
        // A secret: no spell check or autocorrect that could keep it.
        text.inputEl.spellcheck = false;
        text.inputEl.autocomplete = "off";
      });
    join.addButton((button) =>
      button.setButtonText("Join").onClick(async () => {
        button.setDisabled(true);
        try {
          const vault = await host.joinVault(code);
          new Notice(`Vault Sync: you joined ${quotedVaultLabel(vault)} as ${roleName(vault.role).toLowerCase()}.`);
          await this.connect(vault);
        } catch (error) {
          new Notice(`Vault Sync: could not join: ${errorMessage(error)}`);
        } finally {
          button.setDisabled(false);
        }
      }),
    );

    let name = this.app.vault.getName();
    let encrypted = false;
    let escrow = false;
    let escrowAvailable = false;
    // Until the server's escrow default is known, no encrypted vault is
    // created, so that escrow is never left off by mistake.
    let escrowLoaded = false;
    let escrowToggle: ToggleComponent | undefined;
    new Setting(containerEl)
      .setName("Create a vault")
      .setDesc("Create a vault on the server with this name, and sync this Obsidian vault with it. Other members see this name.")
      .addText((text) =>
        text.setValue(name).onChange((value) => {
          name = value;
        }),
      )
      .addButton((button) =>
        button.setButtonText("Create and connect").onClick(async () => {
          if (encrypted && !escrowLoaded) {
            new Notice("Vault Sync: could not create the vault: the server's escrow setting has not loaded.");
            return;
          }
          button.setDisabled(true);
          try {
            await this.connect(await host.createRemoteVault(name, encrypted ? { escrow } : undefined));
          } catch (error) {
            new Notice(`Vault Sync: could not create the vault: ${errorMessage(error)}`);
          } finally {
            button.setDisabled(false);
          }
        }),
      );
    const encryptionSetting = new Setting(containerEl).setName("End-to-end encryption").setDesc("Encrypt notes and file names so the server cannot read them.");
    let encryptionToggle: ToggleComponent | undefined;
    encryptionSetting.addToggle((toggle) => {
      encryptionToggle = toggle;
      // Off until this device's encryption key is known to be unlocked: an encrypted vault needs it.
      toggle
        .setValue(encrypted)
        .setDisabled(true)
        .onChange((value) => {
          encrypted = value;
          updateEscrowToggle();
        });
    });
    void encryption.then(
      (state) => {
        if (state === "unlocked") {
          encryptionToggle?.setDisabled(false);
          return;
        }
        encryptionSetting.setDesc(
          state === "not-enabled"
            ? "Encrypt notes and file names so the server cannot read them. To use it, turn on encryption for your account first (End-to-end encryption, above)."
            : "Encrypt notes and file names so the server cannot read them. To use it, unlock your encryption key first (End-to-end encryption, above).",
        );
      },
      (error: unknown) => {
        encryptionSetting.setDesc(`Could not check encryption: ${errorMessage(error)}`);
      },
    );
    const escrowSetting = new Setting(containerEl).setName("Escrow").setDesc("Loading the server's escrow setting…");
    // Escrow only applies to an encrypted vault, so it shows only while End-to-end encryption is on.
    const updateEscrowToggle = () => {
      escrowToggle?.setDisabled(!escrowAvailable);
      escrowSetting.settingEl.toggle(encrypted);
    };
    escrowSetting.addToggle((toggle) => {
      escrowToggle = toggle;
      toggle.onChange((value) => {
        escrow = value;
      });
    });
    updateEscrowToggle();
    void host.escrowOffer().then(
      (offer) => {
        escrowLoaded = true;
        if (offer.change !== undefined) {
          escrowToggle?.setValue(false);
          updateEscrowToggle();
          this.showEscrowChange(escrowSetting, offer.change);
          return;
        }
        escrowAvailable = offer.recipient !== undefined;
        escrow = offer.byDefault;
        escrowToggle?.setValue(escrow);
        updateEscrowToggle();
        escrowSetting.setDesc(
          offer.recipient !== undefined
            ? `Let the server operator read and restore encrypted vaults, for example if you lose your passphrase. If it is off and you lose your passphrase, the server's copy is lost. ${newVaultEscrowText(offer.recipient.bundle)}`
            : "This server does not offer escrow.",
        );
      },
      (error: unknown) => {
        escrowSetting.setDesc(`Could not load the server's escrow setting: ${errorMessage(error)}`);
      },
    );
  }

  /**
   * Shows an open escrow change on `setting`: the status and a button that
   * opens the escrow reset prompt. The prompt opens by itself once for each
   * new escrow key, unless the user already declined that key.
   */
  private showEscrowChange(setting: Setting, change: EscrowChange): void {
    const open = () => {
      openEscrowReset(this.app, this.host, change);
    };
    setting.setDesc(`${ESCROW_CHANGE_STATUS} Vaults are created without escrow until you accept the new key.`);
    setting.addButton((button) => button.setButtonText("Review the change").onClick(open));
    const offered = escrowKeyFingerprint(change.offered);
    if (!change.declined && this.promptedEscrowKey !== offered) {
      this.promptedEscrowKey = offered;
      open();
    }
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
/** Opens the escrow reset prompt for `change`; accepting or declining it is saved on this device. */
function openEscrowReset(app: App, host: SettingsHost, change: EscrowChange): void {
  new EscrowResetModal(
    app,
    change,
    () => host.acceptEscrowChange(change).catch((error: unknown) => {
        new Notice(`Vault Sync: could not accept the new escrow key: ${errorMessage(error)}`);
      }),
    () => host.declineEscrowChange(change).catch((error: unknown) => {
        new Notice(`Vault Sync: could not save the decline: ${errorMessage(error)}`);
      }),
  ).open();
}

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

function removeMemberText(member: MemberRow): string {
  return `${member.label} can no longer sync or read this vault. Their changes and history stay. They can join again only with a new invitation.`;
}

interface ConfirmOptions {
  title: string;
  text: string;
  confirm: string;
  /** Whether the confirmation is destructive (a warning button). */
  warning?: boolean;
  onConfirm: () => void;
  /** Called when the modal closes without the confirmation. */
  onCancel?: () => void;
  /** Text the user must type, exactly, before the confirm button works (deleteConfirmed). */
  typeToConfirm?: string;
}

/** A confirmation for a membership change (#34). */
class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private readonly options: ConfirmOptions,
  ) {
    super(app);
    this.titleEl.setText(options.title);
  }

  override onOpen(): void {
    const { contentEl, options } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: options.text });
    let typed = "";
    let confirmButton: ButtonComponent | undefined;
    const expected = options.typeToConfirm;
    if (expected !== undefined) {
      new Setting(contentEl).addText((text) =>
        text.setPlaceholder(expected).onChange((value) => {
          typed = value;
          confirmButton?.setDisabled(!deleteConfirmed(typed, expected));
        }),
      );
    }
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) => {
        confirmButton = button;
        button.setDisabled(expected !== undefined);
        button.setButtonText(options.confirm).onClick(() => {
          if (expected !== undefined && !deleteConfirmed(typed, expected)) return;
          this.confirmed = true;
          this.close();
          options.onConfirm();
        });
        // What setWarning does; its replacement, setDestructive, needs Obsidian 1.13, above minAppVersion.
        if (options.warning === true) button.buttonEl.addClass("mod-warning");
        else button.setCta();
      });
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.confirmed) this.options.onCancel?.();
  }
}

/**
 * Converting the connected plaintext vault to end-to-end encryption
 * (docs/design/encryption.md, "Converting a plaintext vault"): lists every
 * member's key fingerprint as the server reports it, and sends the switch only
 * after the owner confirmed they compared every one with its member outside
 * Vault Sync.
 */
class ConvertVaultModal extends Modal {
  constructor(
    app: App,
    private readonly host: SettingsHost,
    private readonly onConverted: () => void,
  ) {
    super(app);
    this.titleEl.setText("Convert to end-to-end encryption?");
  }

  override onOpen(): void {
    const { contentEl, host } = this;
    contentEl.empty();
    const intro = contentEl.createEl("p", { text: "Loading the members' key fingerprints…" });
    void Promise.all([host.conversionMembers(), host.escrowOffer()]).then(
      ([members, offer]) => {
        intro.setText(
          "Compare each fingerprint below with that member over a channel you trust, such as in person or a call. The server reports these keys, and only a comparison shows that it did not swap one. Members, notes and history are kept; earlier versions stay readable and Re-encrypt history encrypts them afterwards.",
        );
        for (const member of members) new Setting(contentEl).setName(member.displayName === "" ? member.userId : member.displayName).setDesc(conversionMemberText(member));
        let compared = false;
        let escrow = offer.recipient !== undefined && offer.change === undefined && offer.byDefault;
        let convertButton: ButtonComponent | undefined;
        if (offer.change !== undefined) {
          new Setting(contentEl).setName("Escrow").setDesc(`${ESCROW_CHANGE_STATUS} The vault is converted without escrow until you accept the new key in the Vault Sync settings.`).addToggle((toggle) => toggle.setValue(false).setDisabled(true));
        } else if (offer.recipient !== undefined) {
          new Setting(contentEl)
            .setName("Escrow")
            .setDesc("Also wrap the vault key to the server operator's escrow key, so that the vault can be recovered and exported without your passphrase.")
            .addToggle((toggle) =>
              toggle.setValue(escrow).onChange((value) => {
                escrow = value;
              }),
            );
        }
        new Setting(contentEl).setName("I compared every member's fingerprint with them").addToggle((toggle) =>
          toggle.setValue(false).onChange((value) => {
            compared = value;
            convertButton?.setDisabled(!conversionConfirmable(members, compared));
          }),
        );
        new Setting(contentEl)
          .addButton((button) =>
            button.setButtonText("Cancel").onClick(() => {
              this.close();
            }),
          )
          .addButton((button) => {
            convertButton = button;
            button
              .setButtonText("Convert")
              .setCta()
              .setDisabled(true)
              .onClick(() => {
                if (!conversionConfirmable(members, compared)) return;
                button.setDisabled(true);
                host.convertVault(members, escrow).then(
                  () => {
                    this.close();
                    this.onConverted();
                  },
                  (error: unknown) => {
                    new Notice(`Vault Sync: could not convert the vault: ${errorMessage(error)}`);
                    this.close();
                  },
                );
              });
          });
      },
      (error: unknown) => {
        intro.setText(`Could not load the members' key fingerprints: ${errorMessage(error)}`);
      },
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** A new invitation's code, shown once (#34): the server keeps only its hash. */
class InviteCodeModal extends Modal {
  constructor(
    app: App,
    private readonly created: CreatedInvitation,
  ) {
    super(app);
    this.titleEl.setText("Invitation created");
  }

  override onOpen(): void {
    const { contentEl, created } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: `Give this code to the person you invite, over a channel you trust. They join as ${roleName(created.invitation.role).toLowerCase()} by entering it under Join with an invite code in Vault Sync's settings. It works once. ${created.invitation.description} It is shown only now: copy it before you close this window.`,
    });
    contentEl.createDiv({ text: created.code, cls: "vault-sync-invite-code" });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Copy code").onClick(() => {
          void navigator.clipboard.writeText(created.code).then(() => new Notice("Code copied"));
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Done")
          .setCta()
          .onClick(() => {
            this.close();
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
