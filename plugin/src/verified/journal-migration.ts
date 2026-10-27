// The migration from the current engine's journal (plugin/src/core/journal,
// IndexedDbJournal at its current schema) to the verified core's (#1042;
// docs/design/verified-core.md §2.2). It reads the engine's journal through
// its `Journal` interface and never writes it, so a migration that fails, or
// a crash before its result is persisted, leaves the engine's journal as it
// was and the migration runs again.
import type { DeferReason, DeferredRevision, DocumentKindName, DocumentState, Journal, PendingOperation, RemoteRevision } from "../core/journal/journal";
import type { Blocker, CoreConflict, CoreDocument, CoreJournal, CoreJournalStore, CoreRevision, Kind } from "./journal-store";

/** The engine's journal holds something the core's journal cannot; nothing was migrated. */
export class JournalMigrationRefused extends Error {
  override name = "JournalMigrationRefused";
}

/**
 * The core's journal for the engine's `journal`:
 * - a row's base is the document's synced revision (none for a create not
 *   acknowledged yet, whose row has no revision id); its binding and absence
 *   are the row's, a bound row's absence being `never`;
 * - its ahead is the document's deferred revision, the reason becoming the
 *   blocker (`path-conflict` is `PathHeld`) and keeping `postponed`;
 * - its outbox is the document's pending operation, sealed unless recorded
 *   as not sealed (an operation from before outbox semantics may have been
 *   sent); a pending operation or deferral of a document with no row gets a
 *   row of its own;
 * - the cursor and its anchor are the engine's: the anchor is the feed
 *   anchor of SPEC.md §8;
 * - the conflict log keeps every record that names a copy (one with no copy
 *   kept nothing to point the UI at).
 *
 * The engine's per-row bookkeeping the core does not model (file keys, own
 * commit anchors, `prior`, `cachedPath`, sizes, `descendsFromBase`) is not
 * carried. Refuses, with JournalMigrationRefused, a journal with open
 * intents (the engine's start-up recovery finishes them first), with more
 * than one pending operation for a document (the core's outbox holds one),
 * or with a `yjs` revision (the core knows notes and binary files only).
 */
export async function migrateEngineJournal(journal: Journal): Promise<CoreJournal> {
  const [states, pending, deferred, intents, conflicts, cursor, anchor] = await Promise.all([
    journal.listDocuments(),
    journal.listPending(),
    journal.listDeferred(),
    journal.listIntents(),
    journal.listConflicts(),
    journal.getCursor(),
    journal.getCursorAnchor(),
  ]);
  if (intents.length > 0) {
    throw new JournalMigrationRefused(`the engine's journal has ${String(intents.length)} open intent(s); recover them before migrating`);
  }

  const documents: Record<string, CoreDocument> = {};
  for (const state of states) documents[state.documentId] = rowOf(state);

  const outboxOf = new Map<string, PendingOperation>();
  for (const operation of pending) {
    if (outboxOf.has(operation.documentId)) {
      throw new JournalMigrationRefused(`document ${operation.documentId} has more than one pending operation`);
    }
    outboxOf.set(operation.documentId, operation);
  }
  for (const [documentId, operation] of outboxOf) {
    const row = (documents[documentId] ??= unrecordedCreate(operation));
    row.outbox = {
      rev: operation.revisionId,
      baseRev: operation.baseRevisionId === "" ? null : operation.baseRevisionId,
      path: operation.path,
      content: operation.contentHash,
      kind: kindOf(operation.kind),
      deleted: operation.deleted,
      sealed: operation.sealed ?? true,
      rejected: false,
    };
  }

  for (const deferral of deferred) {
    const documentId = deferral.revision.documentId;
    const row = (documents[documentId] ??= { base: null, ahead: null, binding: null, absence: "never", outbox: null });
    row.ahead = { revision: revisionOf(deferral.revision), blocker: blockerOf(deferral), postponed: deferral.postponed === true };
  }

  return {
    documents,
    cursor,
    anchor: anchor === undefined ? null : anchor.slice(),
    intents: [],
    conflicts: conflicts.flatMap((record): CoreConflict[] => (record.copyPath === null ? [] : [{ doc: record.documentId === "" ? null : record.documentId, copy: record.copyPath, reason: record.reason }])),
  };
}

/**
 * The core's journal from `store`; if none was persisted yet, the migration
 * of the engine's `legacy` journal, persisted first. A crash before that
 * write lands leaves nothing persisted, so the next start migrates again.
 */
export async function loadOrMigrate(store: CoreJournalStore, legacy: Journal): Promise<CoreJournal> {
  const stored = await store.load();
  if (stored !== undefined) return stored;
  const migrated = await migrateEngineJournal(legacy);
  await store.persist(migrated);
  return migrated;
}

function rowOf(state: DocumentState): CoreDocument {
  if (state.binding === undefined || (state.binding === null && (state.absence === undefined || state.absence === null))) {
    throw new JournalMigrationRefused(`document ${state.documentId} has no recorded binding or absence (a journal from before refactor step R4)`);
  }
  const binding = state.binding;
  return {
    base:
      state.revisionId === ""
        ? null
        : { rev: state.revisionId, position: state.seq, path: state.path, content: state.baseHash, kind: kindOf(state.kind), deleted: state.deleted },
    ahead: null,
    binding: binding === null ? null : { spelling: binding.spelling, seen: binding.seen, displaced: binding.displaced === true, userSpelling: binding.userSpelling ?? null },
    absence: binding === null ? (state.absence ?? "never") : "never",
    outbox: null,
  };
}

/** The row of a create pending with no document row (as a journal from before refactor step R5a can hold): bound to its file, unless it deletes it. */
function unrecordedCreate(operation: PendingOperation): CoreDocument {
  return {
    base: null,
    ahead: null,
    binding: operation.deleted ? null : { spelling: operation.path, seen: operation.contentHash, displaced: false, userSpelling: null },
    absence: operation.deleted ? "user-deleted" : "never",
    outbox: null,
  };
}

function revisionOf(revision: RemoteRevision): CoreRevision {
  return {
    id: revision.revisionId,
    doc: revision.documentId,
    position: revision.seq,
    parent: revision.parentRevisionId === "" ? null : revision.parentRevisionId,
    path: revision.path,
    content: revision.contentHash,
    kind: kindOf(revision.kind),
    deleted: revision.deleted,
    device: revision.deviceId ?? "",
  };
}

const blockers: Record<Exclude<DeferReason, "unmaterializable">, Blocker> = {
  "local-changes": { kind: "local-changes" },
  "invalid-path": { kind: "invalid-path" },
  "path-conflict": { kind: "path-held" },
  "out-of-scope": { kind: "out-of-scope" },
  "too-large": { kind: "too-large" },
};

function blockerOf(deferral: DeferredRevision): Blocker {
  if (deferral.reason === "unmaterializable") return { kind: "unmaterializable", alias: deferral.unmaterializable === "alias" };
  return { ...blockers[deferral.reason] };
}

function kindOf(kind: DocumentKindName): Kind {
  switch (kind) {
    case "text":
      return "note";
    case "blob":
      return "binary";
    case "yjs":
      throw new JournalMigrationRefused("the core has no kind for a yjs document");
  }
}
