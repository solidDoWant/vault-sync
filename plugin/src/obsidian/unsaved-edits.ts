// No Obsidian import: the session (./session.ts) recognizes this error, and
// its unit tests run without Obsidian.

/**
 * A remote write reached a file open in a view with unsaved state it could
 * not merge with: a Markdown editor whose unsaved edits overlap the remote
 * change, or another view (e.g. a canvas) with anything unsaved. The adapter
 * saved the view (so the state is on disk and the engine sees it as a local
 * change next time) and wrote nothing.
 */
export class UnsavedEditsError extends Error {
  override readonly name = "UnsavedEditsError";

  constructor(readonly path: string) {
    super(`${path} has unsaved edits that the incoming change cannot be merged with`);
  }
}
