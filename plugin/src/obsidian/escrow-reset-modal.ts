/**
 * The escrow reset prompt (docs/design/encryption.md, "Escrow reset on a
 * device"): the server's escrow key changed without a rotation statement
 * signed by the pinned key. The prompt shows both fingerprints and accepts
 * only after the user types the new fingerprint's last group. Closing it
 * any other way declines the change on this device.
 */
import { type App, Modal, Setting, type ButtonComponent } from "obsidian";

import { fingerprintLastGroupMatches } from "../core/e2ee/identity";
import type { EscrowChange } from "../core/keys/encrypted-vault";
import { escrowKeyFingerprint } from "./sharing";

/** The status an escrowed vault the user owns shows while an escrow change is open and not accepted. */
export const ESCROW_CHANGE_STATUS = "Escrow uses the previous key: the server's escrow key changed.";

export class EscrowResetModal extends Modal {
  private accepted = false;

  constructor(
    app: App,
    private readonly change: EscrowChange,
    private readonly onAccept: () => Promise<void>,
    private readonly onDecline: () => Promise<void>,
  ) {
    super(app);
    this.titleEl.setText("The server's escrow key changed");
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const newFingerprint = escrowKeyFingerprint(this.change.offered);
    contentEl.createEl("p", {
      text: "The server now uses a new escrow key. The previous escrow key did not sign this change, so Vault Sync cannot prove that the new key belongs to your admin. Someone who controls the server can also cause this.",
    });
    contentEl.createEl("p", { text: `Previous escrow key fingerprint: ${escrowKeyFingerprint(this.change.pinned)}` });
    contentEl.createEl("p", { text: `New escrow key fingerprint: ${newFingerprint}` });
    contentEl.createEl("p", {
      text: "Before you accept, ask your admin for the escrow key fingerprint they publish, and compare it with the new fingerprint. Accept only if they are the same.",
    });
    contentEl.createEl("p", {
      text: "If you accept, the keys of the vaults that you own are also encrypted to the new escrow key from now on, and new vaults use it. If you decline, escrow keeps the previous key, and you cannot create a vault with escrow until you accept.",
    });
    let acceptButton: ButtonComponent | undefined;
    let typed = "";
    new Setting(contentEl)
      .setName("Last group of the new fingerprint")
      .setDesc("Type the last four characters of the new fingerprint to accept it.")
      .addText((text) =>
        text.onChange((value) => {
          typed = value;
          acceptButton?.setDisabled(!fingerprintLastGroupMatches(newFingerprint, typed));
        }),
      );
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Decline").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) => {
        acceptButton = button;
        button
          .setButtonText("Accept the new escrow key")
          .setCta()
          .setDisabled(true)
          .onClick(() => {
            if (!fingerprintLastGroupMatches(newFingerprint, typed)) return;
            this.accepted = true;
            this.close();
            void this.onAccept();
          });
      });
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.accepted) void this.onDecline();
  }
}
