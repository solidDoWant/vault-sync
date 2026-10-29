import { Modal, Notice, PluginSettingTab, Setting, type App, type ButtonComponent, type Plugin, type ToggleComponent } from "obsidian";

import { VaultRole, type Vault } from "../gen/vaultsync/v1/types_pb";
import type { AuthState } from "../core/auth/tokens";
import type { EscrowOffer } from "../core/keys/encrypted-vault";
import { connectProblem } from "./controller";
import { type ConnectedVault, type PluginData } from "./data";
import { DeviceListLoads, DeviceRemovals, type DeviceRow } from "./devices";
import { quotedVaultLabel, vaultLabel } from "./display-text";
import { deleteConfirmed, membershipErrorMessage, parseInvitationDays, roleDescription, roleName, roles, type CreatedInvitation, type MemberRow, type Sharing } from "./sharing";
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
  /** Creates a vault: plaintext, or end-to-end encrypted (with or without escrow) when `encryption` is given. */
  createRemoteVault(name: string, encryption?: { escrow: boolean }): Promise<Vault>;
  /** The server's escrow key and default, for a new encrypted vault. */
  escrowOffer(): Promise<EscrowOffer>;
  connectVault(vault: Vault, confirmed?: boolean): Promise<"connected" | "needs-confirmation">;
  disconnectVault(): Promise<void>;
  /** The signed-in user's devices (#590). */
  listDevices(): Promise<DeviceRow[]>;
  /** Removes another of the user's devices. */
  removeDevice(deviceId: string): Promise<void>;
  /** Registers this installation again after its device was removed, and starts sync. */
  registerAgain(): Promise<void>;
  /** The connected vault's Sharing section (#34). */
  loadSharing(): Promise<Sharing>;
  /** Creates an invitation to the connected vault, redeemable for `days` days (the server's default when undefined). */
  createInvitation(role: VaultRole, days: number | undefined): Promise<CreatedInvitation>;
  revokeInvitation(invitationId: string): Promise<void>;
  setMemberRole(userId: string, role: VaultRole): Promise<void>;
  removeMember(userId: string): Promise<void>;
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
  /** Bumped by every render, hide and Sharing load, so only the latest load paints the Sharing section, and none once the tab is hidden. */
  private sharingLoads = 0;

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

  /** Rebuilds the tab, e.g. after the account state changed. */
  render(): void {
    const { containerEl, host } = this;
    containerEl.empty();
    this.closeDevices();
    this.sharingLoads++;
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


    if (host.authState === "signed-in") {
      this.renderVault(containerEl);
      if (host.connectedVault !== undefined) this.renderSharing(containerEl);
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
    host.encryptionState().then(
      (state) => {
        if (state === "unlocked") {
          setting.setDesc("Enabled for your account and unlocked on this device. The key is kept only in this device's Vault Sync data, which never syncs.");
          setting.addButton((button) =>
            button.setButtonText("Change passphrase").onClick(() => {
              open("change");
            }),
          );
        } else if (state === "locked" || state === "key-changed") {
          setting.setDesc(
            state === "locked"
              ? "Enabled for your account on another device. Unlock it on this device with your recovery passphrase."
              : "Locked: your account's encryption key on the server is not the one this device unlocked, so this device no longer uses its copy. Unlock the server's key with its recovery passphrase.",
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

  /**
   * The connected vault's members and invitations (#34). Owners manage them;
   * editors and viewers see their role and can leave. Every change is sent
   * and then the section is read again from the server, so a refused change
   * shows the state the server kept.
   */
  private renderSharing(containerEl: HTMLElement): void {
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
          this.paintSharing(intro, section, sharing, load);
        },
        (error: unknown) => {
          if (generation !== this.sharingLoads) return;
          intro.setDesc(`Could not load the vault's members: ${errorMessage(error)}`);
        },
      );
    };
    load();
  }

  private paintSharing(intro: Setting, section: HTMLElement, sharing: Sharing, reload: () => void): void {
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
          ? "An owner deleted this vault, so it cannot sync. Disconnect it above; the files stay in this vault."
          : "You are no longer a member of this vault, so it cannot sync. Disconnect it above; the files stay in this vault.",
      );
      return;
    }
    const role = sharing.kind === "owner" ? VaultRole.OWNER : sharing.role;
    intro.setDesc(`Your role: ${roleName(role)}. ${roleDescription(role)}`);
    intro.settingEl.addClass("vault-sync-sharing-role");
    if (sharing.kind === "owner") {
      new Setting(section).setName("Members").setHeading();
      const members = section.createDiv({ cls: "vault-sync-members" });
      for (const member of sharing.members) {
        new Setting(members)
          .setName(member.label)
          .setDesc(member.description)
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
        .setDesc("Creates a single-use invite code for the role you choose. Anyone with the code can join until it is used, revoked or expires. Leave the days empty for 7 days; at most 30.")
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
    new Setting(section)
      .setName("Leave vault")
      .setDesc("Ends your membership of this vault: sync stops and the files stay here. To join again you need a new invitation.")
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
    const vaultName = host.connectedVault?.name ?? "";
    if (sharing.kind === "owner" && vaultName !== "") {
      new Setting(section)
        .setName("Delete vault")
        .setDesc("Deletes this vault on the server for every member: all their devices stop syncing and keep their files. The server keeps the data for 30 days, during which only the server's operator can restore it.")
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
    }
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

    let code = "";
    const join = new Setting(containerEl.createDiv({ cls: "vault-sync-join" }))
      .setName("Join with an invite code")
      .setDesc("Paste the code a vault's owner gave you to join their vault and sync this vault with it. To keep the shared vault apart from your notes, open or create another Obsidian vault and join from there.")
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
    const updateEscrowToggle = () => escrowToggle?.setDisabled(!encrypted || !escrowAvailable);
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
    new Setting(containerEl)
      .setName("End-to-end encryption")
      .setDesc("Encrypt the new vault's notes and paths on your devices, so the server stores only ciphertext. Chosen once, when the vault is created. Needs encryption enabled and unlocked on this device (Encryption, above).")
      .addToggle((toggle) =>
        toggle.setValue(encrypted).onChange((value) => {
          encrypted = value;
          updateEscrowToggle();
        }),
      );
    const escrowSetting = new Setting(containerEl).setName("Escrow").setDesc("Loading the server's escrow setting…");
    escrowSetting.addToggle((toggle) => {
      escrowToggle = toggle;
      toggle.onChange((value) => {
        escrow = value;
      });
    });
    updateEscrowToggle();
    void host.escrowOffer().then(
      (offer) => {
        escrowAvailable = offer.recipient !== undefined;
        escrow = offer.byDefault;
        escrowLoaded = true;
        escrowToggle?.setValue(escrow);
        updateEscrowToggle();
        escrowSetting.setDesc(
          escrowAvailable
            ? "For an encrypted vault: also wrap its keys to the server's escrow key, so the operator's backups hold your notes in plaintext and can restore the vault if you lose your passphrase. Turn it off to keep the operator out; without escrow, a lost passphrase loses the server's copy."
            : "This server has no escrow key, so encrypted vaults are created without escrow.",
        );
      },
      (error: unknown) => {
        escrowSetting.setDesc(`Could not load the server's escrow setting: ${errorMessage(error)}`);
      },
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
