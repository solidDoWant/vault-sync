import { ItemView, type WorkspaceLeaf } from "obsidian";

import type { ActivityEntry } from "../core/sync/activity-log";
import { pathClass } from "./shown-dom";
import { statusDescription, statusIcon, type SyncStatus } from "./status";
import { syncViewContent, type FileList, type FileRow } from "./sync-view-model";

export const syncViewType = "vault-sync-status";

/** Where the view reads what it shows. */
export interface SyncViewSource {
  status(): SyncStatus;
  /** The activity log, newest first. */
  activity(): ActivityEntry[];
  /** Tries to reach the server at once. */
  syncNow(): void;
}

/**
 * The sync view in the right sidebar: the status (its tab icon too), when
 * sync next tries to reach the server with "Sync now" while offline, the
 * progress, the pending and incoming files, and the activity log. It keeps no
 * state of its own and opens no notice or modal.
 */
export class SyncView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly source: SyncViewSource,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return syncViewType;
  }

  override getDisplayText(): string {
    return "Vault Sync";
  }

  override getIcon(): string {
    return statusIcon(this.source.status());
  }

  override onOpen(): Promise<void> {
    this.refresh();
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }

  /** Draws the view and its tab icon again from the current status. */
  refresh(): void {
    const status = this.source.status();
    const content = syncViewContent(status, this.source.activity());
    // Not in Obsidian's public API: redraws the tab header, whose icon is getIcon().
    const leaf = this.leaf as WorkspaceLeaf & { updateHeader?: () => void };
    if (typeof leaf.updateHeader === "function") leaf.updateHeader();

    const root = this.contentEl;
    root.empty();
    root.addClass("vault-sync-view");
    root.createEl("h4", { text: content.title, cls: "vault-sync-view-title" });
    root.createEl("p", { text: statusDescription({ state: status.state, conflicts: 0, pending: 0, ...(status.message === undefined ? {} : { message: status.message }) }) });
    if (content.nextAttempt !== undefined) root.createEl("p", { text: `Next try at ${content.nextAttempt}.`, cls: "vault-sync-view-next-attempt" });
    if (content.offerSyncNow) {
      const button = root.createEl("button", { text: "Sync now", cls: ["mod-cta", "vault-sync-view-sync-now"] });
      button.addEventListener("click", () => {
        this.source.syncNow();
      });
    }
    if (content.progress !== undefined) {
      const progress = root.createDiv({ cls: "vault-sync-view-progress" });
      progress.createDiv({ text: content.progress });
      if (content.currentFile !== undefined) progress.createDiv({ text: content.currentFile, cls: pathClass, attr: { dir: "auto" } });
    }
    if (status.conflicts > 0) {
      root.createEl("p", { text: `${String(status.conflicts)} ${status.conflicts === 1 ? "conflict needs" : "conflicts need"} your attention. Run "Show conflicts" to see them.` });
    }

    this.fileSection("Incoming", "Changes from the server that are about to be applied here.", content.incoming, "vault-sync-view-incoming");
    this.fileSection("Waiting to be sent", "Changes on this device that the server doesn't have yet.", content.pending, "vault-sync-view-pending");

    root.createEl("h4", { text: "Activity" });
    if (content.activity.rows.length === 0) {
      root.createEl("p", { text: "Nothing yet.", cls: "vault-sync-view-empty" });
      return;
    }
    const list = root.createEl("ul", { cls: "vault-sync-view-activity" });
    for (const row of content.activity.rows) {
      const item = list.createEl("li");
      item.createSpan({ text: row.time, cls: "vault-sync-view-time" });
      item.appendText(` ${row.action}`);
      if (row.path !== undefined) {
        item.appendText(": ");
        item.createSpan({ text: row.path, cls: pathClass, attr: { dir: "auto" } });
      }
    }
    this.more(list, content.activity.more);
  }

  private fileSection(title: string, explanation: string, files: FileList<FileRow>, cls: string): void {
    if (files.rows.length === 0) return;
    const root = this.contentEl;
    root.createEl("h4", { text: title });
    root.createEl("p", { text: explanation });
    const list = root.createEl("ul", { cls });
    for (const row of files.rows) {
      const item = list.createEl("li", row.conflict ? { cls: "vault-sync-view-conflict" } : {});
      item.createSpan({ text: row.path, cls: pathClass, attr: { dir: "auto" } });
      item.appendText(` (${row.detail})`);
    }
    this.more(list, files.more);
  }

  private more(list: HTMLElement, more: number): void {
    if (more > 0) list.createEl("li", { text: `and ${String(more)} more`, cls: "vault-sync-view-more" });
  }
}
