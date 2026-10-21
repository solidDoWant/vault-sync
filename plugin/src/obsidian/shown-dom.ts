import type { Shown } from "./display-text";

// Renders Shown labels (display-text.ts) with Obsidian's DOM helpers.

/** The class of the element each path of a Shown label is rendered in. */
export const pathClass = "vault-sync-path";

/**
 * Appends `parts` to `parent`: text as text, each path in its own span with
 * `dir="auto"`, which isolates it (unicode-bidi: isolate, styles.css) so its
 * right-to-left letters cannot reorder the label around it (#605). The
 * parent's text is shownText(parts).
 */
export function renderShown(parent: Node, parts: Shown): void {
  for (const part of parts) {
    if (typeof part === "string") parent.appendText(part);
    else parent.createSpan({ text: part.path, cls: pathClass, attr: { dir: "auto" } });
  }
}

/** `parts` as a fragment, for a Notice or a title. */
export function shownFragment(parts: Shown): DocumentFragment {
  return createFragment((fragment) => {
    renderShown(fragment, parts);
  });
}
