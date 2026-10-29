import { ItemView, Notice, TFile, type WorkspaceLeaf } from "obsidian";

import { skippedReasonText, tooLargeUploadText } from "./conflict-text";
import { shownPath, visiblePath } from "./display-text";
import type { ListedConflict, SyncProblemList } from "./session";
import { pathClass, renderShown, shownFragment } from "./shown-dom";

export const conflictViewType = "vault-sync-conflicts";

/** Where the view reads what it lists: the running sync session, if any. */
export interface ConflictSource {
  /** Undefined while sync is not running. */
  problems(): { listProblems(): Promise<SyncProblemList> } | undefined;
}

/**
 * The conflict view (docs/design/engine.md §10): the conflict copies this
 * device created, each with a link to both versions and a button that opens
 * them side by side; the remote files this device skipped, because they are
 * over the size limit or their path cannot be held here (§6, §7); local
 * files over the size limit; and local files whose names the server refused
 * (rule P3). It reads the journal through the session and keeps no state of
 * its own; deleting or renaming a conflict copy resolves its entry.
 */
export class ConflictView extends ItemView {
  /** Bumped by every refresh, so only the latest one renders. */
  private renderCount = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly conflictSource: ConflictSource,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return conflictViewType;
  }

  override getDisplayText(): string {
    return "Sync conflicts";
  }

  override getIcon(): string {
    return "git-compare";
  }

  override async onOpen(): Promise<void> {
    // A deleted, renamed or recreated copy changes what is open at once, before the next sync.
    const refresh = () => {
      void this.refresh();
    };
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    await this.refresh();
  }

  override onClose(): Promise<void> {
    this.renderCount++;
    this.contentEl.empty();
    return Promise.resolve();
  }

  /** Reads what the session lists again and shows it. */
  async refresh(): Promise<void> {
    const render = ++this.renderCount;
    const source = this.conflictSource.problems();
    let problems: SyncProblemList = { conflicts: [], refused: [], skipped: [], tooLarge: [] };
    let failure: string | undefined;
    if (source !== undefined) {
      try {
        problems = await source.listProblems();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    if (render !== this.renderCount) return;
    const root = this.contentEl;
    root.empty();
    root.addClass("vault-sync-conflict-view");
    if (source === undefined) {
      root.createEl("p", { text: "Sync is not running, so there is nothing to show. Sign in and connect this vault in the Vault Sync settings.", cls: "vault-sync-conflicts-idle" });
      return;
    }
    if (failure !== undefined) root.createEl("p", { text: `Could not read the sync journal: ${failure}`, cls: "vault-sync-conflicts-error" });

    root.createEl("h4", { text: "Conflicts" });
    if (problems.conflicts.length === 0) root.createEl("p", { text: "No conflicts.", cls: "vault-sync-conflicts-empty" });
    else {
      root.createEl("p", { text: "The server's version stayed in place; the other version was kept as a conflict copy. Copy what you need into the note, then delete the conflict copy to resolve the conflict." });
      const list = root.createEl("ul", { cls: "vault-sync-conflicts" });
      for (const conflict of problems.conflicts) this.renderConflict(list.createEl("li", { cls: "vault-sync-conflict" }), conflict);
    }

    if (problems.skipped.length > 0) {
      root.createEl("h4", { text: "Files not on this device" });
      root.createEl("p", { text: "These files are synced, but this device cannot hold them. They stay on the server and on your other devices." });
      const list = root.createEl("ul", { cls: "vault-sync-skipped" });
      for (const document of problems.skipped) {
        const item = list.createEl("li", { cls: "vault-sync-skipped-document" });
        item.createDiv({ text: visiblePath(document.path), cls: "vault-sync-skipped-path" });
        item.createDiv({ text: skippedReasonText(document.reason, document.size), cls: "vault-sync-skipped-reason" });
      }
    }

    if (problems.tooLarge.length > 0 || problems.refused.length > 0) root.createEl("h4", { text: "Files that are not synced" });
    if (problems.tooLarge.length > 0) {
      const list = root.createEl("ul", { cls: "vault-sync-too-large" });
      for (const file of problems.tooLarge) {
        const item = list.createEl("li", { cls: "vault-sync-too-large-file" });
        this.fileLine(item, "File", file.path, "vault-sync-too-large-path");
        item.createDiv({ text: tooLargeUploadText(file.size), cls: "vault-sync-too-large-reason" });
      }
    }
    if (problems.refused.length > 0) {
      root.createEl("p", { text: "The server does not accept these files' names, so they stay on this device only. Rename or move a file to a valid name to sync it." });
      const list = root.createEl("ul", { cls: "vault-sync-rejected" });
      for (const refused of problems.refused) {
        const item = list.createEl("li", { cls: "vault-sync-rejected-file" });
        this.fileLine(item, "File", refused.path, "vault-sync-rejected-path");
        item.createDiv({ text: `The server refused it: ${refused.reason}`, cls: "vault-sync-rejected-reason" });
      }
    }
  }

  private renderConflict(item: HTMLElement, { copy, original, createdAt }: ListedConflict): void {
    renderShown(item.createDiv({ cls: "vault-sync-conflict-path" }), ["Conflict copy: ", shownPath(copy), ` · ${new Date(createdAt).toLocaleString()}`]);
    const versions = item.createDiv();
    this.fileLine(versions, "Kept in place", original, "vault-sync-conflict-original");
    this.fileLine(versions, "Conflict copy", copy, "vault-sync-conflict-copy");
    if (original !== null) {
      const compare = item.createEl("button", { text: "Compare side by side", cls: "vault-sync-compare" });
      compare.addEventListener("click", () => {
        void this.compare(original, copy);
      });
    }
  }

  /** A label and a link that opens `path`, or "no longer exists". */
  private fileLine(parent: HTMLElement, label: string, path: string | null, cls: string): void {
    const line = parent.createDiv();
    line.appendText(`${label}: `);
    if (path === null) {
      line.createSpan({ text: "no longer exists", cls });
      return;
    }
    // Its own element with dir="auto": the path cannot reorder the label (#605).
    const link = line.createEl("a", { text: visiblePath(path), href: "#", cls: [cls, pathClass], attr: { dir: "auto" } });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void this.openPath(path, event.ctrlKey || event.metaKey);
    });
  }

  private async openPath(path: string, newTab: boolean): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) {
      this.gone(path);
      return;
    }
    await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
  }

  /** Opens `original` in a new tab and `copy` in a pane split off to its right. */
  async compare(original: string, copy: string): Promise<void> {
    const left = this.app.vault.getFileByPath(original);
    const right = this.app.vault.getFileByPath(copy);
    if (left === null || right === null) {
      this.gone(left === null ? original : copy);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(left);
    await this.app.workspace.createLeafBySplit(leaf, "vertical").openFile(right);
  }

  /** A link whose file was removed since the view was drawn (#417): says so, and draws the view again. */
  private gone(path: string): void {
    new Notice(shownFragment(["Vault Sync: ", shownPath(path), " no longer exists."]));
    void this.refresh();
  }
}
