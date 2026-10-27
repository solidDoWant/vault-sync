// A test adapter for the verified local-event core (#965,
// docs/design/verified-core.md §3.4): plugin/verified/LocalCoreJs.dfy compiled
// to JavaScript, called with plain TypeScript values. It is test code only:
// nothing in the plugin imports it, and the shell that runs the core for the
// engine is #952.
//
// `CoreDevice` is one device's disk and journal. A user's action changes the
// disk, as in the specification's `User` step, and (unless the test loses the
// event) hands the core the local event with the shell's read of every path
// it names (`LocalReads`, §2.3). `scan()` hands the core the listing. Each
// answer's journal replaces the device's, and the effects are recorded.
import BigNumber from "bignumber.js";

import { pathKey } from "../core/pathkey/pathkey";
import { PathSpace } from "../core/engine/pathspace";
import { filesystemKey, type PathPlatform } from "../core/vaultpath/platform";
import verified from "./gen/verified.cjs";

type Str = ReturnType<typeof verified._dafny.Seq.UnicodeFromString>;
type DafnyJournal = Parameters<
  typeof verified.LocalCoreJs.__default.OnLocal
>[1];
type DafnyDocument =
  Parameters<
    typeof verified.LocalCoreJs.Journal.create_Journal
  >[0] extends ReadonlyArray<readonly [unknown, infer V]>
    ? V
    : never;
type DafnyEffect = ReturnType<
  typeof verified.LocalCoreJs.__default.OnLocal
>[1][number];
type DafnyKind = Parameters<typeof verified.LocalCoreJs.Base.create_Base>[4];

export type Kind = "note" | "binary";
export type Absence = "user-deleted" | "released" | "never";

export interface Base {
  rev: string;
  position: number;
  path: string;
  content: string;
  kind: Kind;
  deleted: boolean;
}

export interface Binding {
  spelling: string;
  seen: string;
  displaced: boolean;
  userSpelling: string | null;
}

export interface Outbox {
  rev: string;
  baseRev: string | null;
  path: string;
  content: string;
  kind: Kind;
  deleted: boolean;
  sealed: boolean;
  rejected: boolean;
}

/** One journal row. `ahead` is not modelled: local events and the scan never read or change it. */
export interface Document {
  base: Base | null;
  binding: Binding | null;
  absence: Absence;
  outbox: Outbox | null;
}

export interface Journal {
  documents: Record<string, Document>;
  cursor: number;
}

/** A file on the disk: its content (the content is its own hash here) and kind. */
export interface DiskFile {
  content: string;
  kind: Kind;
}

export type LocalEvent =
  | { kind: "created"; path: string }
  | { kind: "modified"; path: string }
  | { kind: "deleted"; path: string }
  | { kind: "renamed"; from: string; to: string };

export type Effect =
  | { kind: "persist-journal"; journal: Journal }
  | { kind: "other"; description: string };

export interface Answer {
  journal: Journal;
  effects: Effect[];
}

const D = verified.LocalCoreJs;
const runtime = verified._dafny;

const str = (value: string): Str => runtime.Seq.UnicodeFromString(value);
const text = (value: Str): string => value.toVerbatimString(false);

function some(value: unknown) {
  return D.Option.create_Some(value);
}
function none() {
  return D.Option.create_None();
}

const platforms: readonly PathPlatform[] = [
  "posix",
  "android",
  "windows",
  "macos",
];

function platformOf(value: Str): PathPlatform {
  const platform = text(value);
  const found = platforms.find((candidate) => candidate === platform);
  if (found === undefined)
    throw new RangeError(`local core: unknown platform ${platform}`);
  return found;
}

// The path model's functions (plugin/verified/spec/Paths.dfy), as
// plugin/src/core/pathkey/path-axioms.test.ts checks their axioms (#951).
Object.assign(verified.VerifiedPathHost, {
  FileKey: (platform: Str, path: Str) =>
    str(filesystemKey(text(path), platformOf(platform))),
  ServerKey: (path: Str) => str(pathKey(text(path))),
  FileKeyPath: (platform: Str, path: Str) =>
    str(filesystemKey(text(path), platformOf(platform))),
  ServerKeyPath: (path: Str) => str(pathKey(text(path))),
  Folders: (path: Str) =>
    runtime.Set.fromElements(...new PathSpace().ancestors(text(path)).map(str)),
  SameNameModuloFolders: (platform: Str, p: Str, q: Str) =>
    new PathSpace({ platform: platformOf(platform) }).sameButFolderSpelling(
      text(p),
      text(q),
    ),
});

function kindTo(kind: Kind): DafnyKind {
  return kind === "note" ? D.Kind.create_Note() : D.Kind.create_Binary();
}
function kindFrom(kind: DafnyKind): Kind {
  return kind.is_Note ? "note" : "binary";
}

function optionTo<T>(value: T | null, convert: (value: T) => unknown) {
  return value === null ? none() : some(convert(value));
}

function documentTo(document: Document): DafnyDocument {
  const absence =
    document.absence === "user-deleted"
      ? D.Absence.create_UserDeleted()
      : document.absence === "released"
        ? D.Absence.create_Released()
        : D.Absence.create_Never();
  return D.Document.create_Document(
    optionTo(document.base, (base) =>
      D.Base.create_Base(
        str(base.rev),
        new BigNumber(base.position),
        str(base.path),
        str(base.content),
        kindTo(base.kind),
        base.deleted,
      ),
    ) as never,
    none(),
    optionTo(document.binding, (binding) =>
      D.Binding.create_Binding(
        str(binding.spelling),
        str(binding.seen),
        binding.displaced,
        optionTo(binding.userSpelling, str) as never,
      ),
    ) as never,
    absence,
    optionTo(document.outbox, (outbox) =>
      D.Outbox.create_Outbox(
        str(outbox.rev),
        optionTo(outbox.baseRev, str) as never,
        str(outbox.path),
        str(outbox.content),
        kindTo(outbox.kind),
        outbox.deleted,
        outbox.sealed,
        outbox.rejected,
      ),
    ) as never,
  );
}

function documentFrom(document: DafnyDocument): Document {
  if (document.dtor_ahead.is_Some)
    throw new Error("local core: a row gained an ahead revision");
  const base = document.dtor_base;
  const binding = document.dtor_binding;
  const outbox = document.dtor_outbox;
  const absence = document.dtor_absence;
  return {
    base: base.is_Some
      ? {
          rev: text(base.dtor_value.dtor_rev),
          position: base.dtor_value.dtor_position.toNumber(),
          path: text(base.dtor_value.dtor_path),
          content: text(base.dtor_value.dtor_content),
          kind: kindFrom(base.dtor_value.dtor_kind),
          deleted: base.dtor_value.dtor_deleted,
        }
      : null,
    binding: binding.is_Some
      ? {
          spelling: text(binding.dtor_value.dtor_spelling),
          seen: text(binding.dtor_value.dtor_seen),
          displaced: binding.dtor_value.dtor_displaced,
          userSpelling: binding.dtor_value.dtor_userSpelling.is_Some
            ? text(binding.dtor_value.dtor_userSpelling.dtor_value)
            : null,
        }
      : null,
    absence: absence.is_UserDeleted
      ? "user-deleted"
      : absence.is_Released
        ? "released"
        : "never",
    outbox: outbox.is_Some
      ? {
          rev: text(outbox.dtor_value.dtor_rev),
          baseRev: outbox.dtor_value.dtor_baseRev.is_Some
            ? text(outbox.dtor_value.dtor_baseRev.dtor_value)
            : null,
          path: text(outbox.dtor_value.dtor_path),
          content: text(outbox.dtor_value.dtor_content),
          kind: kindFrom(outbox.dtor_value.dtor_kind),
          deleted: outbox.dtor_value.dtor_deleted,
          sealed: outbox.dtor_value.dtor_sealed,
          rejected: outbox.dtor_value.dtor_rejected,
        }
      : null,
  };
}

function journalTo(journal: Journal): DafnyJournal {
  let documents = runtime.Map.Empty as unknown as Parameters<
    typeof D.Journal.create_Journal
  >[0];
  for (const [id, document] of Object.entries(journal.documents))
    documents = documents.update(str(id), documentTo(document));
  return D.Journal.create_Journal(
    documents,
    new BigNumber(journal.cursor),
    runtime.Seq.of(),
    runtime.Seq.of(),
  );
}

function journalFrom(journal: DafnyJournal): Journal {
  if (journal.dtor_intents.length > 0 || journal.dtor_conflicts.length > 0)
    throw new Error("local core: a journal gained intents or conflicts");
  const documents: Record<string, Document> = {};
  for (const [id, document] of journal.dtor_documents)
    documents[text(id)] = documentFrom(document);
  return { documents, cursor: journal.dtor_cursor.toNumber() };
}

function effectFrom(effect: DafnyEffect): Effect {
  return effect.is_PersistJournal
    ? { kind: "persist-journal", journal: journalFrom(effect.dtor_journal) }
    : { kind: "other", description: effect.toString() };
}

function answerFrom(answer: ReturnType<typeof D.__default.OnLocal>): Answer {
  return {
    journal: journalFrom(answer[0]),
    effects: answer[1].map(effectFrom),
  };
}

function revsTo(journal: Journal, revs: Record<string, string>) {
  let map = runtime.Map.Empty as unknown as Parameters<
    typeof D.__default.OnLocal
  >[4];
  for (const id of Object.keys(journal.documents)) {
    const rev = revs[id];
    // OnLocal/OnScan: requires journal.documents.Keys <= revs.Keys.
    if (rev === undefined)
      throw new RangeError(`local core: no fresh revision for ${id}`);
    map = map.update(str(id), str(rev));
  }
  return map;
}

/** A read at a path: the file there under the platform's file key, or null. */
export type Read = DiskFile | null;

/** The core's answer to a local event, given the shell's reads of the paths the event names. */
export function onLocal(
  platform: PathPlatform,
  journal: Journal,
  event: LocalEvent,
  reads: Record<string, Read>,
  revs: Record<string, string>,
): Answer {
  const local =
    event.kind === "created"
      ? D.LocalEvent.create_Created(str(event.path))
      : event.kind === "modified"
        ? D.LocalEvent.create_Modified(str(event.path))
        : event.kind === "deleted"
          ? D.LocalEvent.create_Deleted(str(event.path))
          : D.LocalEvent.create_Renamed(str(event.from), str(event.to));
  let input = runtime.Map.Empty as unknown as Parameters<
    typeof D.__default.OnLocal
  >[3];
  for (const [path, read] of Object.entries(reads)) {
    input = input.update(
      str(path),
      (read === null
        ? none()
        : some(
            runtime.Tuple.of(str(read.content), kindTo(read.kind)),
          )) as never,
    );
  }
  return answerFrom(
    D.__default.OnLocal(
      str(platform),
      journalTo(journal),
      local,
      input,
      revsTo(journal, revs),
    ),
  );
}

/** The core's answer to the start-up scan with the vault listing. */
export function onScan(
  platform: PathPlatform,
  journal: Journal,
  listing: ReadonlyMap<string, DiskFile>,
  revs: Record<string, string>,
): Answer {
  // OnScan: requires ListingDistinct (no two listed names are one file under F).
  const keys = new Set<string>();
  let map = runtime.Map.Empty as unknown as Parameters<
    typeof D.__default.OnScan
  >[2];
  for (const [path, file] of listing) {
    const key = filesystemKey(path, platform);
    if (keys.has(key))
      throw new RangeError(
        `local core: two listed names are one file at ${path}`,
      );
    keys.add(key);
    map = map.update(
      str(path),
      runtime.Tuple.of(str(file.content), kindTo(file.kind)),
    );
  }
  return answerFrom(
    D.__default.OnScan(
      str(platform),
      journalTo(journal),
      map,
      revsTo(journal, revs),
    ),
  );
}

/** A document synced at `path` with `content`: its base and binding, nothing to send. */
export function synced(
  id: string,
  path: string,
  content: string,
  kind: Kind = "note",
): Document {
  return {
    base: { rev: `${id}@1`, position: 1, path, content, kind, deleted: false },
    binding: {
      spelling: path,
      seen: content,
      displaced: false,
      userSpelling: null,
    },
    absence: "never",
    outbox: null,
  };
}

/** One device: a disk, the journal, and every answer of the core. */
export class CoreDevice {
  readonly disk = new Map<string, DiskFile>();
  readonly answers: Answer[] = [];
  journal: Journal;
  private revisions = 0;

  constructor(
    readonly platform: PathPlatform,
    documents: Record<string, Document>,
  ) {
    this.journal = { documents: structuredClone(documents), cursor: 0 };
    for (const document of Object.values(documents)) {
      if (document.binding !== null) {
        this.disk.set(document.binding.spelling, {
          content: document.binding.seen,
          kind: document.base?.kind ?? "note",
        });
      }
    }
  }

  /** The row of a document. */
  row(id: string): Document {
    const document = this.journal.documents[id];
    if (document === undefined) throw new Error(`no row ${id}`);
    return document;
  }

  /** The spelling on disk that names `path` under the platform's file key. */
  private spellingOf(path: string): string | undefined {
    const key = filesystemKey(path, this.platform);
    return [...this.disk.keys()].find(
      (spelling) => filesystemKey(spelling, this.platform) === key,
    );
  }

  /** The shell's read at `path` (`ReadAt`). */
  read(path: string): Read {
    const spelling = this.spellingOf(path);
    return spelling === undefined ? null : (this.disk.get(spelling) ?? null);
  }

  /** The user writes a file; the vault reports a create or a modify unless `lost`. */
  write(
    path: string,
    content: string,
    options: { kind?: Kind; lost?: boolean } = {},
  ): void {
    const spelling = this.spellingOf(path);
    this.disk.set(spelling ?? path, { content, kind: options.kind ?? "note" });
    if (options.lost !== true)
      this.deliver({
        kind: spelling === undefined ? "created" : "modified",
        path,
      });
  }

  /** The user deletes a file. */
  delete(path: string, options: { lost?: boolean } = {}): void {
    const spelling = this.spellingOf(path);
    if (spelling === undefined) throw new Error(`no file at ${path}`);
    this.disk.delete(spelling);
    if (options.lost !== true) this.deliver({ kind: "deleted", path });
  }

  /**
   * The user renames a file (onto a free name, or only its case). `kind` is
   * the kind the new name reads as (another extension), the file's own by
   * default.
   */
  rename(
    from: string,
    to: string,
    options: { lost?: boolean; kind?: Kind } = {},
  ): void {
    const spelling = this.spellingOf(from);
    const file = spelling === undefined ? undefined : this.disk.get(spelling);
    if (spelling === undefined || file === undefined)
      throw new Error(`no file at ${from}`);
    this.disk.delete(spelling);
    const target = this.spellingOf(to);
    if (target !== undefined) this.disk.delete(target);
    this.disk.set(to, { ...file, kind: options.kind ?? file.kind });
    if (options.lost !== true) this.deliver({ kind: "renamed", from, to });
  }

  /** Hands the core a local event with the reads of the paths it names, now. */
  deliver(event: LocalEvent): Answer {
    const paths =
      event.kind === "renamed" ? [event.from, event.to] : [event.path];
    const reads: Record<string, Read> = {};
    for (const path of paths) reads[path] = this.read(path);
    return this.apply(
      onLocal(this.platform, this.journal, event, reads, this.freshRevs()),
    );
  }

  /** The start-up scan, with the disk as its listing. */
  scan(): Answer {
    return this.apply(
      onScan(this.platform, this.journal, this.disk, this.freshRevs()),
    );
  }

  private freshRevs(): Record<string, string> {
    this.revisions++;
    return Object.fromEntries(
      Object.keys(this.journal.documents).map((id) => [
        id,
        `${id}#${String(this.revisions)}`,
      ]),
    );
  }

  private apply(answer: Answer): Answer {
    this.answers.push(answer);
    this.journal = answer.journal;
    return answer;
  }
}
