import { Modal, Setting, type App, type ButtonComponent } from "obsidian";

import { passphraseProblem } from "../core/keys/user-key";
import { passphraseErrorMessage } from "./encryption";

/** "enable" asks for a new passphrase twice; "unlock" for the existing one once; "change" for the existing one once and a new one twice. */
export type PassphraseMode = "enable" | "unlock" | "change";

const texts: Record<PassphraseMode, { title: string; intro: string; button: string }> = {
  enable: {
    title: "Enable end-to-end encryption",
    intro:
      "Choose a recovery passphrase. Your encryption key is created on this device, and the server stores it only locked with this passphrase. You need the passphrase on every other device, and nobody, including the server's operator, can recover it for you: write it down and keep it safe. If you lose it, your devices keep their local files, but the server's copy of an encrypted vault can be restored only from the operator's escrow, and only for vaults created with escrow.",
    button: "Enable encryption",
  },
  unlock: {
    title: "Unlock end-to-end encryption",
    intro: "Enter the recovery passphrase chosen when encryption was enabled. After a few wrong passphrases, the server makes you wait before the next try.",
    button: "Unlock",
  },
  change: {
    title: "Change the recovery passphrase",
    intro:
      "Enter the current recovery passphrase, then the new one. Your encryption key stays the same, so devices where it is unlocked keep working. Other devices need the new passphrase from now on. Wrong current passphrases count against the server's limit, as when unlocking.",
    button: "Change passphrase",
  },
};

/**
 * Asks for the recovery passphrase and runs `submit` with it (docs/plugin.md,
 * "End-to-end encryption"). It stays open with the reason when `submit`
 * fails, such as a wrong passphrase or, after too many, the time the server
 * allows the next try. The passphrase is never stored or logged.
 */
export class PassphraseModal extends Modal {
  private passphrase = "";
  private newPassphrase = "";
  private confirmation = "";
  private running = false;
  private messageEl: HTMLElement | undefined;
  private button: ButtonComponent | undefined;

  constructor(
    app: App,
    private readonly mode: PassphraseMode,
    private readonly submit: (passphrase: string, newPassphrase: string) => Promise<void>,
  ) {
    super(app);
    this.titleEl.setText(texts[mode].title);
  }

  override onOpen(): void {
    const { contentEl, mode } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: texts[mode].intro });
    new Setting(contentEl).setName(mode === "change" ? "Current passphrase" : "Passphrase").addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = mode === "enable" ? "new-password" : "current-password";
      text.onChange((value) => {
        this.passphrase = value;
      });
    });
    if (mode === "change") {
      new Setting(contentEl).setName("New passphrase").addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.onChange((value) => {
          this.newPassphrase = value;
        });
      });
    }
    if (mode !== "unlock") {
      new Setting(contentEl).setName(mode === "change" ? "Repeat the new passphrase" : "Repeat the passphrase").addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.onChange((value) => {
          this.confirmation = value;
        });
      });
    }
    this.messageEl = contentEl.createEl("p", {
      cls: "vault-sync-passphrase-message",
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) => {
        this.button = button;
        button
          .setButtonText(texts[mode].button)
          .setCta()
          .onClick(() => void this.run());
      });
  }

  override onClose(): void {
    this.passphrase = "";
    this.newPassphrase = "";
    this.confirmation = "";
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    if (this.mode !== "enable" && this.passphrase === "") {
      this.messageEl?.setText(this.mode === "change" ? "Enter the current passphrase." : "Enter the passphrase.");
      return;
    }
    if (this.mode !== "unlock") {
      const chosen = this.mode === "enable" ? this.passphrase : this.newPassphrase;
      const problem = passphraseProblem(chosen) ?? (chosen === this.confirmation ? undefined : "The passphrases do not match.");
      if (problem !== undefined) {
        this.messageEl?.setText(problem);
        return;
      }
    }
    this.running = true;
    this.button?.setDisabled(true);
    this.messageEl?.setText("Deriving the key from the passphrase. This can take several seconds on a phone…");
    try {
      await this.submit(this.passphrase, this.newPassphrase);
      this.close();
    } catch (error) {
      this.messageEl?.setText(passphraseErrorMessage(error, (time) => time.toLocaleString()));
    } finally {
      this.running = false;
      this.button?.setDisabled(false);
    }
  }
}
