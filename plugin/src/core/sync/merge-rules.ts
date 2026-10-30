import { blobMergeFor, mergeBlob } from "../merge/file-merge";
import { mergeText } from "../merge/text-merge";
import type { SyncKind } from "./journal";

/** The two sides of a content conflict and how to reach the base (docs/design/engine.md §5, rule M). */
export interface ContentSides {
  kind: SyncKind;
  /** The path the merged content is written to; its extension picks the merge strategy within a kind. */
  path: string;
  local: Uint8Array;
  localHash: string;
  /** The local file's modification time, in ms since the epoch. */
  localTime: number;
  remote: Uint8Array;
  remoteHash: string;
  /** The remote revision's `create_time`, in ms since the epoch. */
  remoteTime: number;
  baseHash: string;
  /** The base revision's content; null when retention pruned it. */
  base: () => Promise<Uint8Array | null>;
}

/** What rule M decides: the content at the path, and the content saved as a conflict copy, if any. */
export interface ContentOutcome {
  content: Uint8Array;
  /** The losing side, saved as a conflict copy (rule C); null when nothing is lost. */
  copy: Uint8Array | null;
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * Rule M: merges the local and the remote content of one document. A local
 * side unchanged from the base takes the remote content, as does a local
 * side equal to it. `TEXT` is merged three-way, and when that conflicts the
 * remote version stays at the path and the local one is the copy. `BLOB`:
 * a type with a merge strategy (`.base`, `.canvas`, `.json`, plain text) is
 * first merged three-way (mergeBlob); otherwise,
 * or when that merge falls back, the newer side stays at the path, the
 * remote one on a tie, and the other is the copy.
 */
export async function mergeContent(sides: ContentSides): Promise<ContentOutcome> {
  const takeRemote: ContentOutcome = { content: sides.remote, copy: null };
  if (sides.localHash === sides.remoteHash || sides.localHash === sides.baseHash) return takeRemote;
  // Only the local side changed the content (the remote revision moved or re-created it): no conflict.
  if (sides.remoteHash === sides.baseHash) return { content: sides.local, copy: null };
  const keepRemote: ContentOutcome = { content: sides.remote, copy: sides.local };
  if (sides.kind === "blob") {
    if (blobMergeFor(sides.path) !== null) {
      const base = await sides.base();
      const merged = base === null ? null : mergeBlob(sides.path, base, sides.local, sides.remote);
      if (merged !== null) return merged === sides.remote ? takeRemote : { content: merged, copy: null };
    }
    return sides.localTime > sides.remoteTime ? { content: sides.local, copy: sides.remote } : keepRemote;
  }
  const local = decode(sides.local);
  const remote = decode(sides.remote);
  if (local === null || remote === null) return keepRemote;
  if (normalized(local) === normalized(remote)) return takeRemote;
  const baseBytes = await sides.base();
  const base = baseBytes === null ? null : decode(baseBytes);
  if (base === null) return keepRemote;
  const merged = mergeText(base, local, remote);
  if (merged === null) return keepRemote;
  return merged === remote ? takeRemote : { content: encoder.encode(merged), copy: null };
}

function decode(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/** The text with LF line endings and no trailing newline. */
function normalized(text: string): string {
  return text.replaceAll("\r\n", "\n").replace(/\n$/u, "");
}
