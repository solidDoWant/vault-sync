import { FuzzySuggestModal, Modal, Notice, Setting, type App } from "obsidian";

import { RestoreError, type HistoryEntry } from "../core/engine/history";
import type { DocumentState } from "../core/journal/journal";
import { shownPath, visiblePath, type Shown } from "./display-text";
import { entryLabel, historyTitle, otherPathValue, previewOf, restoreFailureText, sizeLabel } from "./history-view";
import { renderShown, shownFragment } from "./shown-dom";
import type { VaultHistory } from "./session";
import { errorMessage } from "./status";

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const formatTime = (date: Date) => timeFormat.format(date);

/**
 * A document's history (SPEC.md §11): its retained revisions, newest first,
 * with time and device. Choosing one previews it; "Restore this version"
 * commits it as the document's new head revision, which also brings a
 * deleted document back.
 */
export class HistoryModal extends Modal {
  private entries: HistoryEntry[] = [];
  private nextPageToken = "";
  private selected: { entry: HistoryEntry; content: Uint8Array | undefined } | undefined;
  private listEl!: HTMLElement;
  private moreEl!: HTMLElement;
  private previewEl!: HTMLElement;
  /** Whether the user may restore here (VaultHistory.canRestore): a viewer may not (#417). */
  private canRestore: Promise<boolean> = Promise.resolve(true);

  constructor(
    app: App,
    private readonly history: VaultHistory,
    private readonly documentId: string,
    path: string,
  ) {
    super(app);
    this.titleEl.empty();
    renderShown(this.titleEl, historyTitle(path));
    this.modalEl.addClass("vault-sync-history");
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.listEl = contentEl.createDiv({ cls: "vault-sync-history-list" });
    this.moreEl = contentEl.createDiv();
    this.previewEl = contentEl.createDiv({ cls: "vault-sync-history-preview" });
    this.previewEl.createEl("p", { text: "Choose a version to preview it.", cls: "vault-sync-history-hint" });
    this.canRestore = this.readCanRestore();
    void this.load(true);
  }

  /** VaultHistory.canRestore, true when it cannot tell (it rejects or throws): the server still decides (#527). */
  private async readCanRestore(): Promise<boolean> {
    try {
      return (await this.history.canRestore?.()) ?? true;
    } catch {
      return true;
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  /** Loads the newest page (`fresh`) or the next older one. */
  private async load(fresh: boolean): Promise<void> {
    if (fresh) {
      this.entries = [];
      this.nextPageToken = "";
      this.listEl.empty();
      this.listEl.createEl("p", { text: "Loading history…" });
    }
    try {
      const page = await this.history.history(this.documentId, fresh ? "" : this.nextPageToken);
      this.entries.push(...page.entries);
      this.nextPageToken = page.nextPageToken;
    } catch (error) {
      this.listEl.empty();
      this.listEl.createEl("p", { text: `The history could not be loaded: ${errorMessage(error)}`, cls: "vault-sync-history-error" });
      return;
    }
    this.renderList();
  }

  private renderList(): void {
    this.listEl.empty();
    this.entries.forEach((entry, index) => {
      const row = this.listEl.createDiv({ cls: "vault-sync-history-entry" });
      renderShown(row, entryLabel(entry, this.entries[index + 1], formatTime));
      row.dataset.revisionId = entry.revisionId;
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      if (index === 0) row.createSpan({ text: " (current)", cls: "vault-sync-history-current" });
      if (entry.revisionId === this.selected?.entry.revisionId) row.addClass("is-selected");
      row.addEventListener("click", () => void this.select(entry));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") void this.select(entry);
      });
    });
    this.moreEl.empty();
    if (this.nextPageToken !== "") {
      new Setting(this.moreEl).addButton((button) => button.setButtonText("Load older versions").onClick(() => void this.load(false)));
    }
  }

  private async select(entry: HistoryEntry): Promise<void> {
    this.selected = { entry, content: undefined };
    this.renderList();
    const { previewEl } = this;
    previewEl.empty();
    previewEl.createEl("p", { text: "Loading this version…" });
    let content: Uint8Array | undefined;
    try {
      content = await this.history.readRevision(entry);
    } catch (error) {
      if (this.selected.entry !== entry) return;
      previewEl.empty();
      previewEl.createEl("p", { text: `This version could not be loaded: ${errorMessage(error)}`, cls: "vault-sync-history-error" });
      return;
    }
    if (this.selected.entry !== entry) return;
    this.selected.content = content;
    previewEl.empty();
    const preview = previewOf(content);
    if (preview.kind === "text") {
      previewEl.createEl("pre", { text: preview.text, cls: "vault-sync-history-text" });
      if (preview.truncated) previewEl.createEl("p", { text: `Only the start is shown (the version is ${sizeLabel(content.length)}).`, cls: "vault-sync-history-hint" });
    } else {
      previewEl.createEl("p", { text: `Binary content, ${sizeLabel(preview.size)}.`, cls: "vault-sync-history-hint" });
    }
    if (entry === this.entries[0] && !entry.deleted) return;
    const allowed = await this.canRestore;
    if (this.selected.entry !== entry) return;
    if (!allowed) {
      previewEl.createEl("p", { text: "You can view this vault but not change it, so you cannot restore versions.", cls: "vault-sync-history-viewer" });
      return;
    }
    new Setting(previewEl).addButton((button) =>
      button
        .setButtonText("Restore this version")
        .setCta()
        .onClick(() => {
          button.setDisabled(true);
          void this.restore(entry, content).finally(() => {
            button.setDisabled(false);
          });
        }),
    );
  }

  /** Restores `entry`, at `path` if given; offers another path when its own is taken (#420). */
  private async restore(entry: HistoryEntry, content: Uint8Array | undefined, path?: string): Promise<void> {
    try {
      const restored = await this.history.restore(entry, content, path);
      new Notice(shownFragment(["Vault Sync: restored ", shownPath(restored.path), ` to the version of ${entry.createdAt === undefined ? "an unknown time" : formatTime(entry.createdAt)}.`]));
      this.selected = undefined;
      this.previewEl.empty();
      await this.load(true);
    } catch (error) {
      // Built here, not taken from the engine's message: the path in it may be another member's (#605).
      const message: Shown = error instanceof RestoreError ? restoreFailureText(error) : [errorMessage(error)];
      new Notice(shownFragment(["Vault Sync: the version could not be restored: ", ...message]));
      const otherPath = error instanceof RestoreError && (error.reason === "path-taken" || (error.reason === "invalid-path" && path !== undefined));
      if (otherPath && this.selected?.entry === entry) this.offerOtherPath(entry, content, error, path);
    }
  }

  /**
   * A path field and a button that restores `entry` there, after a restore
   * at `typed` (or at its own path, if undefined) failed (otherPathValue).
   */
  private offerOtherPath(entry: HistoryEntry, content: Uint8Array | undefined, failure: RestoreError, typed: string | undefined): void {
    this.previewEl.querySelector(".vault-sync-history-other-path")?.remove();
    const container = this.previewEl.createDiv({ cls: "vault-sync-history-other-path" });
    let target = otherPathValue(failure, typed, (path) => this.app.vault.getAbstractFileByPath(path) !== null);
    new Setting(container)
      .setName("Restore at another path")
      .setDesc(typed === undefined ? "Its own path is taken by another file. Restore it at this path instead." : failure.reason === "invalid-path" ? "That path cannot be used. Correct it and restore again." : "That path is taken by another file too. Restore it at this path instead.")
      .addText((text) =>
        text.setValue(target).onChange((value) => {
          target = value.trim();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Restore here").onClick(() => {
          button.setDisabled(true);
          void this.restore(entry, content, target).finally(() => {
            button.setDisabled(false);
          });
        }),
      );
  }
}

/** Picks one of the deleted files this device knows of, most recently deleted first, and opens its history. */
export class DeletedFilesModal extends FuzzySuggestModal<DocumentState> {
  constructor(
    app: App,
    private readonly history: VaultHistory,
    private readonly deleted: DocumentState[],
  ) {
    super(app);
    this.setPlaceholder(deleted.length === 0 ? "No deleted files" : "Find a deleted file to restore");
  }

  getItems(): DocumentState[] {
    return this.deleted;
  }

  getItemText(item: DocumentState): string {
    return visiblePath(item.path);
  }

  onChooseItem(item: DocumentState): void {
    new HistoryModal(this.app, this.history, item.documentId, item.path).open();
  }
}
