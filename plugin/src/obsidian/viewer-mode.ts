import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, type Plugin } from "obsidian";

// A viewer device in Obsidian (docs/design/sharing.md, Viewer devices):
// notes open read-only, in reading view, with a banner, and creating,
// renaming and deleting files is refused with a notice. Changes made anyway
// (outside Obsidian, or by another plugin) are undone by the sync engine,
// which keeps them as local copies.

export const viewerBannerText = "This vault is shared with you as a viewer. Notes are read-only on this device, and changes are not synced.";

export const viewerRefusedNotice = "Vault Sync: this vault is shared with you as a viewer, so files cannot be created, renamed or deleted in it.";

const bannerClass = "vault-sync-viewer-banner";

/**
 * The FileManager methods behind Obsidian's create, rename and delete
 * actions. renameFile, trashFile and promptForDeletion are public API; the
 * create ones are Obsidian's own (1.x) and are guarded only where present.
 */
const guardedMethods = ["renameFile", "trashFile", "promptForDeletion", "createNewMarkdownFile", "createNewFile", "createNewFolder"] as const;

export class ViewerMode {
  private readOnly = false;
  /** The editor extensions registered with Obsidian; filled while read-only. */
  private readonly extensions: Extension[] = [];

  constructor(private readonly plugin: Plugin) {
    plugin.registerEditorExtension(this.extensions);
    plugin.registerEvent(
      plugin.app.workspace.on("layout-change", () => {
        this.showViews();
      }),
    );
    this.guardFileManager();
  }

  /** Whether the device is read-only now. */
  get active(): boolean {
    return this.readOnly;
  }

  /** Makes the open and later opened notes read-only (or editable again). */
  set(readOnly: boolean): void {
    if (readOnly === this.readOnly) return;
    this.readOnly = readOnly;
    this.extensions.length = 0;
    if (readOnly) this.extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    this.plugin.app.workspace.updateOptions();
    this.showViews();
  }

  /** Every Markdown view: the banner while read-only, and reading view. */
  private showViews(): void {
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      const banner = view.containerEl.querySelector(`.${bannerClass}`);
      if (!this.readOnly) {
        banner?.remove();
        return;
      }
      if (banner === null) {
        const element = createDiv({ cls: bannerClass, text: viewerBannerText });
        view.containerEl.insertBefore(element, view.contentEl);
      }
      if (view.getMode() === "source") {
        const state = leaf.getViewState();
        void leaf.setViewState({ ...state, state: { ...state.state, mode: "preview" } });
      }
    });
  }

  /** Refuses Obsidian's create, rename and delete actions while read-only; restored when the plugin unloads. */
  private guardFileManager(): void {
    const fileManager = this.plugin.app.fileManager as unknown as Record<string, unknown>;
    for (const name of guardedMethods) {
      const original = fileManager[name];
      if (typeof original !== "function") continue;
      const guarded = (...args: unknown[]): unknown => {
        if (!this.readOnly) return (original as (...args: unknown[]) => unknown).apply(this.plugin.app.fileManager, args);
        new Notice(viewerRefusedNotice);
        // A refused deletion prompt is a cancelled one.
        if (name === "promptForDeletion") return Promise.resolve(false);
        return Promise.reject(new Error(viewerRefusedNotice));
      };
      fileManager[name] = guarded;
      this.plugin.register(() => {
        if (fileManager[name] === guarded) fileManager[name] = original;
      });
    }
  }
}
