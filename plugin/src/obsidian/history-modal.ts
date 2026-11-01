import { Modal, Notice, Setting, ToggleComponent, setIcon, type App } from "obsidian";

import { RestoreError, type HistoryDocument, type HistoryEntry } from "../core/sync/history";
import { shownPath, type Shown } from "./display-text";
import { diffCounts, foldUnchanged, isFold, lineDiff, matchingDocuments, revertChange, sideBySide, withWordChanges, type DiffLine, type Segment, type SideRow } from "./history-diff";
import { documentTree, foldersOf, type TreeNode } from "./history-tree";
import { entryParts, exactTime, historyTitle, maxPreviewBytes, otherPathValue, previewOf, relativeTime, restoreFailureText, sizeLabel, whoParts, type Preview, type WhoPart } from "./history-view";
import { pathClass, renderShown, shownFragment } from "./shown-dom";
import type { VaultHistory } from "./session";
import { errorMessage } from "./status";

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const formatTime = (date: Date) => timeFormat.format(date);
const versionTime = (entry: HistoryEntry) => (entry.createdAt === undefined ? "an unknown time" : formatTime(entry.createdAt));

/** The most files a search shows at once; typing more narrows it. */
const maxListedFiles = 500;

/** How the selected version is shown, kept while Obsidian runs so each history view opens as the last one was left. */
const viewOptions = { changes: false, sideBySide: false };

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** The class of the times refreshRelativeTimes keeps current. */
const relativeTimeClass = "vault-sync-relative-time";

/** `date` as how long ago it was, like GitHub shows it, with the exact date and time, its time zone named, on hover. */
function renderRelativeTime(parent: HTMLElement, date: Date): void {
  parent.createEl("time", { cls: relativeTimeClass, text: relativeTime(date, new Date()), attr: { datetime: date.toISOString(), title: exactTime(date) } });
}

/** Brings every relative time under `root` up to date. */
function refreshRelativeTimes(root: HTMLElement): void {
  const now = new Date();
  for (const time of Array.from(root.querySelectorAll<HTMLTimeElement>(`time.${relativeTimeClass}`))) {
    const date = new Date(time.dateTime);
    if (!Number.isNaN(date.getTime())) time.setText(relativeTime(date, now));
  }
}

/**
 * Who made a version: "user via device". A user's name shows in a box, and
 * a device in the same box with a device icon: another device by its name,
 * and this device as "this device", tinted in the accent colour, which no
 * name another person chooses can have. Each box shows where the name
 * starts and ends (#548, #557).
 */
function renderWho(parent: HTMLElement, parts: readonly WhoPart[]): void {
  const deviceIcon = (box: HTMLElement) => {
    setIcon(box.createSpan({ cls: "vault-sync-name-icon" }), "monitor-smartphone");
  };
  for (const part of parts) {
    if ("name" in part) {
      const box = parent.createSpan({ cls: part.device === true ? "vault-sync-name is-device" : "vault-sync-name" });
      if (part.device === true) deviceIcon(box);
      box.appendText(part.name);
    } else if ("thisDevice" in part) {
      const box = parent.createSpan({ cls: "vault-sync-name is-device is-this-device", attr: { title: "This device" } });
      deviceIcon(box);
      box.appendText("this device");
    } else {
      parent.appendText(part.text);
    }
  }
}

/** A line of a comparison, with the parts a change touched marked when it is one of a changed pair (withWordChanges). */
function renderLineText(parent: HTMLElement, text: string, segments: Segment[] | undefined): void {
  const element = parent.createSpan({ cls: "vault-sync-diff-text" });
  if (segments === undefined) {
    element.setText(text);
    return;
  }
  for (const segment of segments) element.createSpan({ text: segment.text, cls: segment.changed ? "vault-sync-diff-word is-changed" : "vault-sync-diff-word" });
}

/** A revert that a later change makes impossible: it touches the same lines. */
class RevertConflict extends Error {}

/**
 * The sync history (SPEC.md §11), laid out like Obsidian's File recovery:
 * the synced files with a search, the versions of the chosen file, newest
 * first, and the chosen version. The version shows as it is, or as the
 * changes from the version before it, inline or side by side. It can be
 * copied, restored as the file's new version (which also brings a deleted
 * file back), or reverted: its changes undone in the file while later
 * changes stay.
 */
export class HistoryModal extends Modal {
  private documents: HistoryDocument[] = [];
  private document: HistoryDocument | undefined;
  private entries: HistoryEntry[] = [];
  private nextPageToken = "";
  private selected: { entry: HistoryEntry; preview: Preview | undefined; content: Uint8Array | undefined } | undefined;
  /** The previews read so far, by revision id: only their start for a large revision. */
  private readonly previews = new Map<string, Uint8Array>();
  /** The folders open in the file tree. While a search is typed, every folder shows open. */
  private readonly openFolders = new Set<string>();
  /** Keeps the relative times of the versions current while the view is open. */
  private timeRefresh: number | undefined;
  /** Whether folded unchanged lines are shown, for the selected version. */
  private unfolded = false;
  /** Counts the documents opened, so a late answer for an earlier one is dropped. */
  private generation = 0;
  private searchEl!: HTMLInputElement;
  private filesEl!: HTMLElement;
  private listEl!: HTMLElement;
  private moreEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  /** Whether the user may change files here (VaultHistory.canRestore): a viewer may not (#417). */
  private canRestore: Promise<boolean> = Promise.resolve(true);

  constructor(
    app: App,
    private readonly history: VaultHistory,
    documentId?: string,
    path?: string,
  ) {
    super(app);
    if (documentId !== undefined && path !== undefined) {
      this.document = { documentId, path, deleted: false };
      for (const folder of foldersOf(path)) this.openFolders.add(folder);
    }
    this.modalEl.addClass("vault-sync-history");
    this.showTitle();
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vault-sync-history-body");
    const filesPane = contentEl.createDiv({ cls: "vault-sync-history-pane vault-sync-history-files-pane" });
    this.searchEl = filesPane.createEl("input", { type: "search", cls: "vault-sync-history-search", attr: { placeholder: "Search synced files", "aria-label": "Search synced files" } });
    this.searchEl.addEventListener("input", () => {
      this.renderFiles();
    });
    this.filesEl = filesPane.createDiv({ cls: "vault-sync-history-files" });
    const versionsPane = contentEl.createDiv({ cls: "vault-sync-history-pane vault-sync-history-versions-pane" });
    this.listEl = versionsPane.createDiv({ cls: "vault-sync-history-list" });
    this.moreEl = versionsPane.createDiv();
    const contentPane = contentEl.createDiv({ cls: "vault-sync-history-pane vault-sync-history-content-pane" });
    this.toolbarEl = contentPane.createDiv({ cls: "vault-sync-history-toolbar" });
    this.previewEl = contentPane.createDiv({ cls: "vault-sync-history-preview" });
    this.actionsEl = contentPane.createDiv({ cls: "vault-sync-history-actions" });
    this.canRestore = this.readCanRestore();
    this.timeRefresh = window.setInterval(() => {
      refreshRelativeTimes(this.contentEl);
    }, 30_000);
    void this.loadDocuments();
    if (this.document === undefined) {
      this.listEl.createEl("p", { text: "Choose a file to see its versions.", cls: "vault-sync-history-hint" });
    } else {
      void this.load(true);
    }
    this.renderSelected();
    if (this.document === undefined) this.searchEl.focus();
  }

  override onClose(): void {
    window.clearInterval(this.timeRefresh);
    this.contentEl.empty();
  }

  /** VaultHistory.canRestore, true when it cannot tell (it rejects or throws): the server still decides (#527). */
  private async readCanRestore(): Promise<boolean> {
    try {
      return (await this.history.canRestore?.()) ?? true;
    } catch {
      return true;
    }
  }

  private showTitle(): void {
    this.titleEl.empty();
    if (this.document === undefined) {
      this.titleEl.setText("Sync history");
      return;
    }
    // "History of" as a label, then the path in a box: its folders muted and the file's name in bold.
    for (const part of historyTitle(this.document.path)) {
      if (typeof part === "string") {
        this.titleEl.createSpan({ text: part, cls: "vault-sync-history-title-label" });
        continue;
      }
      renderShown(this.titleEl, [part]);
    }
    const pathEl = this.titleEl.querySelector<HTMLElement>(`.${pathClass}`);
    if (pathEl === null) return;
    // The path element stays as renderShown made it, isolated, with the whole path as its text.
    const text = pathEl.textContent;
    const slash = text.lastIndexOf("/");
    pathEl.empty();
    pathEl.addClass("vault-sync-history-title-path");
    if (slash !== -1) pathEl.createSpan({ text: text.slice(0, slash + 1), cls: "vault-sync-history-title-folder" });
    pathEl.createSpan({ text: text.slice(slash + 1), cls: "vault-sync-history-title-file" });
  }

  /** The synced files to search (VaultHistory.documents); without it, only the file the view opened with. */
  private async loadDocuments(): Promise<void> {
    try {
      this.documents = (await this.history.documents?.()) ?? (this.document === undefined ? [] : [this.document]);
    } catch (error) {
      this.filesEl.empty();
      this.filesEl.createEl("p", { text: `The synced files could not be listed: ${errorMessage(error)}`, cls: "vault-sync-history-error" });
      return;
    }
    const opened = this.document;
    if (opened !== undefined) {
      const known = this.documents.find((document) => document.documentId === opened.documentId);
      if (known !== undefined) this.document = known;
    }
    this.renderFiles();
    this.filesEl.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }

  /** The synced files as a folder tree, or the files that match the search, with their folders open. */
  private renderFiles(): void {
    this.filesEl.empty();
    const searching = this.searchEl.value.trim() !== "";
    const matching = matchingDocuments(this.documents, this.searchEl.value);
    if (matching.length === 0) {
      this.filesEl.createEl("p", { text: this.documents.length === 0 ? "No synced files yet." : "No synced file matches.", cls: "vault-sync-history-hint" });
      return;
    }
    // Closed folders draw nothing below them, so only a search needs a limit.
    this.renderTree(this.filesEl, documentTree(searching ? matching.slice(0, maxListedFiles) : matching), searching);
    if (searching && matching.length > maxListedFiles) this.filesEl.createEl("p", { text: `${String(matching.length - maxListedFiles)} more. Type more to narrow the list.`, cls: "vault-sync-history-hint" });
  }

  private renderTree(parent: HTMLElement, nodes: TreeNode[], searching: boolean): void {
    const activate = (row: HTMLElement, action: () => void) => {
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.addEventListener("click", action);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          action();
        }
      });
    };
    for (const node of nodes) {
      if (node.kind === "folder") {
        const open = searching || this.openFolders.has(node.path);
        const row = parent.createDiv({ cls: "vault-sync-history-folder" });
        row.setAttribute("aria-expanded", String(open));
        setIcon(row.createSpan({ cls: "vault-sync-history-folder-icon" }), open ? "chevron-down" : "chevron-right");
        renderShown(row.createSpan({ cls: "vault-sync-history-folder-name" }), [shownPath(node.name)]);
        row.createSpan({ text: String(node.files), cls: "vault-sync-history-folder-count" });
        activate(row, () => {
          if (searching) return;
          if (open) this.openFolders.delete(node.path);
          else this.openFolders.add(node.path);
          this.renderFiles();
        });
        if (open) this.renderTree(parent.createDiv({ cls: "vault-sync-history-tree-children" }), node.children, searching);
        continue;
      }
      const { document } = node;
      const row = parent.createDiv({ cls: "vault-sync-history-file" });
      renderShown(row, [shownPath(node.name)]);
      if (document.deleted) row.createSpan({ text: " (deleted)", cls: "vault-sync-history-hint" });
      if (document.documentId === this.document?.documentId) row.addClass("is-selected");
      activate(row, () => {
        this.openDocument(document);
      });
    }
  }

  /** Shows the versions of `document`. */
  private openDocument(document: HistoryDocument): void {
    this.document = document;
    for (const folder of foldersOf(document.path)) this.openFolders.add(folder);
    this.selected = undefined;
    this.showTitle();
    this.renderFiles();
    this.renderSelected();
    void this.load(true);
  }

  /** Loads the newest page of the open document's versions (`fresh`) or the next older one. */
  private async load(fresh: boolean): Promise<void> {
    const document = this.document;
    if (document === undefined) return;
    if (fresh) {
      this.generation++;
      this.entries = [];
      this.nextPageToken = "";
      this.listEl.empty();
      this.moreEl.empty();
      this.listEl.createEl("p", { text: "Loading history…" });
    }
    const generation = this.generation;
    try {
      const page = await this.history.history(document.documentId, fresh ? "" : this.nextPageToken);
      if (generation !== this.generation) return;
      this.entries.push(...page.entries);
      this.nextPageToken = page.nextPageToken;
    } catch (error) {
      if (generation !== this.generation) return;
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
      // Three lines: when, what changed, and who (styles.css orders them).
      const parts = entryParts(entry, this.entries[index + 1], formatTime);
      const time = row.createDiv({ cls: "vault-sync-history-entry-time" });
      if (entry.createdAt === undefined) time.setText(parts.when);
      else renderRelativeTime(time, entry.createdAt);
      if (index === 0) time.createSpan({ text: " (current)", cls: "vault-sync-history-current" });
      renderWho(row.createDiv({ cls: "vault-sync-history-entry-who" }), whoParts(entry));
      renderShown(row.createDiv({ cls: "vault-sync-history-entry-change" }), parts.change);
      row.dataset.revisionId = entry.revisionId;
      row.setAttribute("role", "button");
      row.tabIndex = 0;
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

  /** The start of `entry`'s content, at most maxPreviewBytes (#656), read once. */
  private async previewContent(entry: HistoryEntry): Promise<Uint8Array> {
    const cached = this.previews.get(entry.revisionId);
    if (cached !== undefined) return cached;
    const content = await this.history.readRevision(entry, maxPreviewBytes);
    this.previews.set(entry.revisionId, content);
    return content;
  }

  /** All of `entry`'s content: the preview when it is complete, else read again whole. */
  private async fullContent(entry: HistoryEntry): Promise<Uint8Array> {
    const preview = this.previews.get(entry.revisionId);
    if (preview !== undefined && preview.length === Number(entry.size)) return preview;
    return this.history.readRevision(entry);
  }

  private async select(entry: HistoryEntry): Promise<void> {
    this.selected = { entry, preview: undefined, content: undefined };
    this.unfolded = false;
    this.renderList();
    this.renderSelected();
    let content: Uint8Array;
    try {
      content = await this.previewContent(entry);
    } catch (error) {
      if (this.selected.entry !== entry) return;
      this.previewEl.empty();
      this.previewEl.createEl("p", { text: `This version could not be loaded: ${errorMessage(error)}`, cls: "vault-sync-history-error" });
      return;
    }
    if (this.selected.entry !== entry) return;
    const size = Number(entry.size);
    this.selected.preview = previewOf(content, size);
    // Only the complete content can stand in for the revision in a restore.
    this.selected.content = content.length === size ? content : undefined;
    this.renderSelected();
  }

  /** The toolbar, the selected version (as it is, or its changes) and the actions on it. */
  private renderSelected(): void {
    this.toolbarEl.empty();
    this.previewEl.empty();
    this.actionsEl.empty();
    const selected = this.selected;
    if (selected === undefined) {
      this.previewEl.createEl("p", { text: this.document === undefined ? "" : "Choose a version to see it.", cls: "vault-sync-history-hint" });
      return;
    }
    this.renderToolbar();
    if (selected.preview === undefined) {
      this.previewEl.createEl("p", { text: "Loading this version…" });
      return;
    }
    if (viewOptions.changes) void this.renderChanges(selected.entry);
    else this.renderVersion(selected.preview, Number(selected.entry.size));
    void this.renderActions(selected.entry, selected.preview);
  }

  private renderToolbar(): void {
    const toggle = (label: string, value: boolean, disabled: boolean, onChange: (value: boolean) => void) => {
      const item = this.toolbarEl.createEl("label", { cls: "vault-sync-history-toggle" });
      new ToggleComponent(item).setValue(value).setDisabled(disabled).onChange(onChange);
      item.createSpan({ text: label });
    };
    toggle("Show changes", viewOptions.changes, false, (value) => {
      viewOptions.changes = value;
      this.renderSelected();
    });
    toggle("Side by side", viewOptions.sideBySide, !viewOptions.changes, (value) => {
      viewOptions.sideBySide = value;
      this.renderSelected();
    });
  }

  private renderVersion(preview: Preview, size: number): void {
    const { previewEl } = this;
    if (preview.kind === "text") {
      previewEl.createEl("pre", { text: preview.text, cls: "vault-sync-history-text" });
      if (preview.truncated) previewEl.createEl("p", { text: `Only the start is shown (the version is ${sizeLabel(size)}).`, cls: "vault-sync-history-hint" });
    } else {
      previewEl.createEl("p", { text: `Binary content, ${sizeLabel(preview.size)}.`, cls: "vault-sync-history-hint" });
    }
  }

  /** The version before `entry`, loading older versions if it is not listed yet; undefined for the oldest kept version. */
  private async previousOf(entry: HistoryEntry): Promise<HistoryEntry | undefined> {
    for (;;) {
      const index = this.entries.indexOf(entry);
      if (index === -1) return undefined;
      const previous = this.entries[index + 1];
      if (previous !== undefined || this.nextPageToken === "") return previous;
      await this.load(false);
    }
  }

  /** The changes `entry` made to the version before it, inline or side by side. */
  private async renderChanges(entry: HistoryEntry): Promise<void> {
    const { previewEl } = this;
    previewEl.createEl("p", { text: "Comparing with the previous version…" });
    let previous: HistoryEntry | undefined;
    let before: Preview | undefined;
    try {
      previous = await this.previousOf(entry);
      if (previous !== undefined) before = previewOf(await this.previewContent(previous), Number(previous.size));
    } catch (error) {
      if (this.selected?.entry !== entry) return;
      previewEl.empty();
      previewEl.createEl("p", { text: `The previous version could not be loaded: ${errorMessage(error)}`, cls: "vault-sync-history-error" });
      return;
    }
    const after = this.selected?.preview;
    if (this.selected?.entry !== entry || !viewOptions.changes || after === undefined) return;
    previewEl.empty();
    if (previous === undefined || before === undefined) {
      previewEl.createEl("p", { text: "This is the oldest kept version, so there is nothing to compare it with.", cls: "vault-sync-history-hint" });
      this.renderVersion(after, Number(entry.size));
      return;
    }
    if (before.kind !== "text" || after.kind !== "text") {
      previewEl.createEl("p", { text: "Changes can be shown only for text.", cls: "vault-sync-history-hint" });
      this.renderVersion(after, Number(entry.size));
      return;
    }
    if (before.truncated || after.truncated) {
      previewEl.createEl("p", { text: "This file is too large to compare. The version is shown as it is.", cls: "vault-sync-history-hint" });
      this.renderVersion(after, Number(entry.size));
      return;
    }
    const lines = withWordChanges(lineDiff(before.text, after.text));
    const counts = diffCounts(lines);
    previewEl.createEl("p", {
      text: counts.added + counts.removed === 0 ? `No change to the text since the version of ${versionTime(previous)}.` : `Changes since the version of ${versionTime(previous)}: ${String(counts.added)} added, ${String(counts.removed)} removed.`,
      cls: "vault-sync-history-hint vault-sync-diff-summary",
    });
    if (viewOptions.sideBySide) this.renderSideBySide(sideBySide(lines));
    else this.renderInline(lines);
  }

  /** A folded run of unchanged lines: clicking it shows every line. */
  private renderFold(parent: HTMLElement, hidden: number): void {
    const fold = parent.createDiv({ cls: "vault-sync-diff-fold", text: `⋯ ${String(hidden)} unchanged lines` });
    fold.setAttribute("role", "button");
    fold.tabIndex = 0;
    const expand = () => {
      this.unfolded = true;
      this.renderSelected();
    };
    fold.addEventListener("click", expand);
    fold.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") expand();
    });
  }

  private renderInline(lines: DiffLine[]): void {
    const table = this.previewEl.createDiv({ cls: "vault-sync-diff vault-sync-diff-inline" });
    const rows = this.unfolded ? lines : foldUnchanged(lines, (line) => line.kind === "same");
    for (const row of rows) {
      if (isFold(row)) {
        this.renderFold(table, row.fold);
        continue;
      }
      const line = table.createDiv({ cls: `vault-sync-diff-line is-${row.kind}` });
      line.createSpan({ cls: "vault-sync-diff-number", text: row.before === undefined ? "" : String(row.before) });
      line.createSpan({ cls: "vault-sync-diff-number", text: row.after === undefined ? "" : String(row.after) });
      line.createSpan({ cls: "vault-sync-diff-marker", text: row.kind === "added" ? "+" : row.kind === "removed" ? "−" : "" });
      renderLineText(line, row.text, row.segments);
    }
  }

  private renderSideBySide(sideRows: SideRow[]): void {
    const table = this.previewEl.createDiv({ cls: "vault-sync-diff vault-sync-diff-split" });
    const rows = this.unfolded ? sideRows : foldUnchanged(sideRows, (row) => row.left?.kind === "same");
    for (const row of rows) {
      if (isFold(row)) {
        this.renderFold(table, row.fold);
        continue;
      }
      const line = table.createDiv({ cls: "vault-sync-diff-row" });
      for (const cell of [row.left, row.right]) {
        const side = line.createDiv({ cls: `vault-sync-diff-side ${cell === undefined ? "is-empty" : `is-${cell.kind}`}` });
        side.createSpan({ cls: "vault-sync-diff-number", text: cell === undefined ? "" : String(cell.number) });
        renderLineText(side, cell?.text ?? "", cell?.segments);
      }
    }
  }

  /** Copy, and, for a member who may change files, Revert this change and Restore this version. */
  private async renderActions(entry: HistoryEntry, preview: Preview): Promise<void> {
    const isText = preview.kind === "text";
    const bar = new Setting(this.actionsEl).addButton((button) =>
      button
        .setButtonText("Copy")
        .setTooltip(isText ? "Copy the text of this version" : "Only text can be copied")
        .setDisabled(!isText)
        .onClick(() => void this.copy(entry)),
    );
    const current = this.entries[0];
    const isCurrent = entry === current && !entry.deleted;
    const previous = this.entries[this.entries.indexOf(entry) + 1];
    // A revert edits the file on this device: it needs a text change to undo, and the file in place.
    const revertible = isText && !entry.deleted && previous !== undefined && !previous.deleted && current !== undefined && !current.deleted;
    if (isCurrent && !revertible) return;
    const allowed = await this.canRestore;
    // The view was drawn again meanwhile: that drawing shows the actions.
    if (!bar.settingEl.isConnected) return;
    if (!allowed) {
      this.actionsEl.createEl("p", { text: "You can view this vault but not change it, so you cannot restore versions.", cls: "vault-sync-history-viewer" });
      return;
    }
    if (revertible) {
      bar.addButton((button) =>
        button
          .setButtonText("Revert this change")
          .setTooltip("Undo the changes made in this version, and keep the changes made after it")
          .onClick(() => {
            button.setDisabled(true);
            void this.revert(entry, previous).finally(() => {
              button.setDisabled(false);
            });
          }),
      );
    }
    if (!isCurrent) {
      bar.addButton((button) =>
        button
          .setButtonText("Restore this version")
          .setCta()
          .onClick(() => {
            button.setDisabled(true);
            void this.restore(entry, this.selected?.entry === entry ? this.selected.content : undefined).finally(() => {
              button.setDisabled(false);
            });
          }),
      );
    }
  }

  private async copy(entry: HistoryEntry): Promise<void> {
    try {
      const text = strictDecoder.decode(await this.fullContent(entry));
      await navigator.clipboard.writeText(text);
      new Notice(`Vault Sync: copied the version of ${versionTime(entry)}.`);
    } catch (error) {
      new Notice(`Vault Sync: the version could not be copied: ${errorMessage(error)}`);
    }
  }

  /**
   * Undoes the changes `entry` made to `previous` in the file on this
   * device, keeping later changes (revertChange). The file then syncs like
   * any edit.
   */
  private async revert(entry: HistoryEntry, previous: HistoryEntry): Promise<void> {
    const path = this.entries[0]?.path ?? entry.path;
    try {
      const [changed, before] = await Promise.all([this.fullContent(entry), this.fullContent(previous)]);
      const changedText = strictDecoder.decode(changed);
      const previousText = strictDecoder.decode(before);
      const file = this.app.vault.getFileByPath(path);
      if (file === null) {
        new Notice(shownFragment(["Vault Sync: the change could not be reverted: ", shownPath(path), " is not on this device."]));
        return;
      }
      await this.app.vault.process(file, (current) => {
        const reverted = revertChange(changedText, previousText, current);
        if (reverted === null) throw new RevertConflict();
        return reverted;
      });
      new Notice(`Vault Sync: reverted the change of ${versionTime(entry)}. The file syncs as usual.`);
    } catch (error) {
      if (error instanceof RevertConflict) {
        new Notice("Vault Sync: the change could not be reverted, because later changes touch the same lines. Restore a version, or edit the file.");
        return;
      }
      new Notice(`Vault Sync: the change could not be reverted: ${errorMessage(error)}`);
    }
  }

  /** Restores `entry`, at `path` if given; offers another path when its own is taken (#420). */
  private async restore(entry: HistoryEntry, content: Uint8Array | undefined, path?: string): Promise<void> {
    try {
      const restored = await this.history.restore(entry, content, path);
      new Notice(shownFragment(["Vault Sync: restored ", shownPath(restored.path), ` to the version of ${versionTime(entry)}.`]));
      this.selected = undefined;
      this.renderSelected();
      await this.load(true);
      void this.loadDocuments();
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
    this.actionsEl.querySelector(".vault-sync-history-other-path")?.remove();
    const container = this.actionsEl.createDiv({ cls: "vault-sync-history-other-path" });
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
