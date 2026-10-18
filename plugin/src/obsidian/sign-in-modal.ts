import { Modal, Notice, Setting, type App } from "obsidian";

import type { DeviceAuthorization } from "../core/auth/oidc";

/**
 * The device-flow sign-in dialog (SPEC.md §9.1): it shows the verification
 * URL and the user code while the plugin polls the identity provider, and
 * closing it cancels the sign-in. The same dialog works on desktop and
 * mobile: the user can open the page here or on any other device.
 */
export class SignInModal extends Modal {
  private readonly controller = new AbortController();

  constructor(app: App) {
    super(app);
    this.titleEl.setText("Sign in to Vault Sync");
  }

  /** Aborted when the dialog closes, which cancels the sign-in. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Contacting the identity provider…" });
  }

  override onClose(): void {
    this.controller.abort(new SignInCancelledError());
    this.contentEl.empty();
  }

  /** Shows the code the user must enter, and where. */
  showAuthorization(authorization: DeviceAuthorization): void {
    const { contentEl } = this;
    contentEl.empty();
    const target = authorization.verificationUriComplete ?? authorization.verificationUri;
    const intro = contentEl.createEl("p", { text: "Open this page in a browser, on this or any other device, and enter the code below: " });
    intro.createEl("a", { text: authorization.verificationUri, href: target, cls: "vault-sync-verification-uri" });
    contentEl.createDiv({ text: authorization.userCode, cls: "vault-sync-user-code" });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Copy code").onClick(() => {
          void navigator.clipboard.writeText(authorization.userCode).then(() => new Notice("Code copied"));
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Open page")
          .setCta()
          .onClick(() => {
            window.open(target);
          }),
      );
    contentEl.createEl("p", { text: "Waiting for approval…", cls: "vault-sync-sign-in-status" });
  }

  /** Replaces the dialog's content with why the sign-in failed. */
  showError(message: string): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: `Sign-in failed: ${message}`, cls: "vault-sync-sign-in-error" });
  }
}

/** The user closed the sign-in dialog. */
export class SignInCancelledError extends Error {
  override readonly name = "SignInCancelledError";
  constructor() {
    super("sign-in cancelled");
  }
}
