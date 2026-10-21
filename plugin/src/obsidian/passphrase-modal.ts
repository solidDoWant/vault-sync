import { Modal, Setting, type App, type ButtonComponent } from "obsidian";

import { passphraseProblem } from "../core/keys/user-key";
import { passphraseErrorMessage } from "./encryption";

/** "enable" asks for a new passphrase twice; "unlock" for the existing one once. */
export type PassphraseMode = "enable" | "unlock";

const texts: Record<PassphraseMode, { title: string; intro: string; button: string }> = {
  enable: {
    title: "Enable end-to-end encryption",
    intro:
      "Choose a recovery passphrase. Your encryption key is created on this device, and the server stores it only locked with this passphrase. You need the passphrase on every other device, and nobody, including the server's operator, can recover it for you: write it down and keep it safe.",
    button: "Enable encryption",
  },
  unlock: {
    title: "Unlock end-to-end encryption",
    intro: "Enter the recovery passphrase chosen when encryption was enabled. After a few wrong passphrases, the server makes you wait before the next try.",
    button: "Unlock",
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
  private confirmation = "";
  private running = false;
  private messageEl: HTMLElement | undefined;
  private button: ButtonComponent | undefined;

  constructor(
    app: App,
    private readonly mode: PassphraseMode,
    private readonly submit: (passphrase: string) => Promise<void>,
  ) {
    super(app);
    this.titleEl.setText(texts[mode].title);
  }

  override onOpen(): void {
    const { contentEl, mode } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: texts[mode].intro });
    new Setting(contentEl).setName("Passphrase").addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = mode === "enable" ? "new-password" : "current-password";
      text.onChange((value) => {
        this.passphrase = value;
      });
    });
    if (mode === "enable") {
      new Setting(contentEl).setName("Repeat the passphrase").addText((text) => {
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
    this.confirmation = "";
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    if (this.mode === "enable") {
      const problem = passphraseProblem(this.passphrase) ?? (this.passphrase === this.confirmation ? undefined : "The passphrases do not match.");
      if (problem !== undefined) {
        this.messageEl?.setText(problem);
        return;
      }
    } else if (this.passphrase === "") {
      this.messageEl?.setText("Enter the passphrase.");
      return;
    }
    this.running = true;
    this.button?.setDisabled(true);
    this.messageEl?.setText("Deriving the key from the passphrase. This can take several seconds on a phone…");
    try {
      await this.submit(this.passphrase);
      this.close();
    } catch (error) {
      this.messageEl?.setText(passphraseErrorMessage(error, (time) => time.toLocaleString()));
    } finally {
      this.running = false;
      this.button?.setDisabled(false);
    }
  }
}
