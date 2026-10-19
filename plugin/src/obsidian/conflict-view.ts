import { ItemView, TFile, type WorkspaceLeaf } from "obsidian";

import type { OpenConflict } from "../core/engine/conflicts";
import type { UnmaterializableDocument } from "../core/engine/engine";
import { conflictReasonText, unmaterializableReasonText } from "./conflict-text";

export const conflictViewType = "vault-sync-conflicts";

/** Where the view reads what it lists: the running sync session, if any. */
export interface ConflictSource {
  /** Undefined while sync is not running. */
  problems(): { conflicts(): Promise<OpenConflict[]>; unmaterializable(): Promise<UnmaterializableDocument[]> } | undefined;
}

/**
 * The conflict view (SPEC.md §7, §8): the open conflicts of the conflict
 * log, each with a link to both versions and a button that opens them side
 * by side, and the documents this device's platform cannot hold, each with
 * its server path and why. It reads the journal through the session and
 * keeps no state of its own; deleting a conflict copy resolves its entry.
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

  /** Reads the conflicts and unmaterializable documents again and shows them. */
  async refresh(): Promise<void> {
    const render = ++this.renderCount;
    const problems = this.conflictSource.problems();
    let conflicts: OpenConflict[] = [];
    let unmaterializable: UnmaterializableDocument[] = [];
    let failure: string | undefined;
    if (problems !== undefined) {
      try {
        [conflicts, unmaterializable] = await Promise.all([problems.conflicts(), problems.unmaterializable()]);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    if (render !== this.renderCount) return;
    const root = this.contentEl;
    root.empty();
    root.addClass("vault-sync-conflict-view");
    if (problems === undefined) {
      root.createEl("p", { text: "Sync is not running, so there is nothing to show. Sign in and connect this vault in the Vault Sync settings.", cls: "vault-sync-conflicts-idle" });
      return;
    }
    if (failure !== undefined) root.createEl("p", { text: `Could not read the sync journal: ${failure}`, cls: "vault-sync-conflicts-error" });

    root.createEl("h4", { text: "Conflicts" });
    if (conflicts.length === 0) root.createEl("p", { text: "No conflicts.", cls: "vault-sync-conflicts-empty" });
    else {
      root.createEl("p", { text: "The other device's version stayed in place; this device's version was kept as a conflict copy. Copy what you need into the note, then delete the conflict copy to resolve the conflict." });
      const list = root.createEl("ul", { cls: "vault-sync-conflicts" });
      for (const conflict of conflicts) this.renderConflict(list.createEl("li", { cls: "vault-sync-conflict" }), conflict);
    }

    if (unmaterializable.length > 0) {
      root.createEl("h4", { text: "Files this device cannot hold" });
      root.createEl("p", { text: "These documents are synced, but their path on the server is not a valid file name here. Rename them on another device to bring them here. Local changes to them are not synced until then." });
      const list = root.createEl("ul", { cls: "vault-sync-unmaterializable" });
      for (const document of unmaterializable) this.renderUnmaterializable(list.createEl("li", { cls: "vault-sync-unmaterializable-document" }), document);
    }
  }

  private renderConflict(item: HTMLElement, { record, original, copy }: OpenConflict): void {
    item.createDiv({ text: conflictReasonText(record.reason), cls: "vault-sync-conflict-reason" });
    item.createDiv({ text: `Path: ${record.path} · ${new Date(record.at).toLocaleString()}`, cls: "vault-sync-conflict-path" });
    const versions = item.createDiv();
    if (copy === null) {
      this.fileLine(versions, "This device's version (not synced)", original, "vault-sync-conflict-original");
      versions.createDiv({ text: "No conflict-copy name fits the path length limits, so the file stays where it is. Move it to a shorter path to sync it.", cls: "vault-sync-conflict-no-copy" });
      return;
    }
    this.fileLine(versions, record.reason === "path-taken" ? "The other document" : "Kept in place", original, "vault-sync-conflict-original");
    this.fileLine(versions, "Conflict copy", copy, "vault-sync-conflict-copy");
    if (original !== null) {
      const compare = item.createEl("button", { text: "Compare side by side", cls: "vault-sync-compare" });
      compare.addEventListener("click", () => {
        void this.compare(original, copy);
      });
    }
  }

  private renderUnmaterializable(item: HTMLElement, document: UnmaterializableDocument): void {
    item.createDiv({ text: document.path, cls: "vault-sync-unmaterializable-path" });
    item.createDiv({ text: unmaterializableReasonText(document.reason), cls: "vault-sync-unmaterializable-reason" });
    if (document.localPath !== undefined) this.fileLine(item, "Earlier version on this device", document.localPath, "vault-sync-unmaterializable-local");
  }

  /** A label and a link that opens `path`, or "no longer exists". */
  private fileLine(parent: HTMLElement, label: string, path: string | null, cls: string): void {
    const line = parent.createDiv();
    line.appendText(`${label}: `);
    if (path === null) {
      line.createSpan({ text: "no longer exists", cls });
      return;
    }
    const link = line.createEl("a", { text: path, href: "#", cls });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void this.openPath(path, event.ctrlKey || event.metaKey);
    });
  }

  private async openPath(path: string, newTab: boolean): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
  }

  /** Opens `original` in a new tab and `copy` in a pane split off to its right. */
  async compare(original: string, copy: string): Promise<void> {
    const left = this.app.vault.getFileByPath(original);
    const right = this.app.vault.getFileByPath(copy);
    if (left === null || right === null) return;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(left);
    await this.app.workspace.createLeafBySplit(leaf, "vertical").openFile(right);
  }
}
