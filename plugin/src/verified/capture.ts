// Event capture and round inputs of the shell around the verified core
// (#1043, split item 3 of #952; docs/design/verified-core.md §2.3, §3.4).
//
// The shell hands the core one input at a time, in the order the vault
// reported them, through `EventCapture`:
//
// - A local event goes with the shell's read of every path it names (one, or
//   both names of a rename) under the device's `F`, taken when the event is
//   handed over (spec/Engine.dfy `LocalReads`).
// - The start-up scan goes with the vault listing: every file's spelling with
//   its content and kind (`Scan`), no two names one file under `F`
//   (`ListingDistinct`).
// - A sync round's input (`RoundInput`, `RoundInputOf`) is the listing, the
//   paths an open editor holds unsaved text at, the paths the device does not
//   sync, and enough fresh document ids (`FreshDocsSuffice`).
//
// The core takes the scan as one step, but listing the disk takes time, and
// the vault keeps reporting changes meanwhile. An event that arrived while
// the scan listed the disk may describe a change the listing already shows;
// handing it to the core after the scan would apply that change twice (the
// scan matches `a.md → b.md`, then a late `Renamed(a.md, b.md)` finds the
// document at `b.md` and unbinds it, #979 item 2). Such an event is stale and
// the shell drops it: when every path it names reads now as the listing shows
// it, the listing holds its change. Dropping an event is always safe: the
// specification lets any local event be lost, and the next round's listing
// shows every file. An event whose change came after the listing (a path
// reads differently now) is handed over with the reads of now.
import { filesystemKey, type PathPlatform } from "../core/vaultpath/platform";
import type { CoreIntentKind } from "./journal-store";
import type { DiskFile, LocalEvent, Read } from "./local-core";

/** What the shell reads of the device's vault. */
export interface VaultReader {
  readonly platform: PathPlatform;
  /** The spelling of every file in the vault. */
  list(): Promise<readonly string[]>;
  /** The file at `path` under the platform's file key, or null when none is there. */
  read(path: string): Promise<Read>;
  /** The paths at which an open editor holds text not yet saved to the file. */
  unsaved(): Promise<readonly string[]>;
  /**
   * Whether the device syncs `path` (SPEC.md §8 ".obsidian/ config sync").
   * It must give one answer for every spelling of a file under the platform's
   * file key (spec/Contracts.dfy `ScopesClosedUnderF`): the scope is asked per
   * spelling, and a listed spelling and a pulled path of one file must agree.
   */
  inScope(path: string): boolean;
}

/** One input for the core: a local event with its reads, or the scan with its listing. */
export type CoreInput =
  | { kind: "local"; event: LocalEvent; reads: Record<string, Read> }
  | { kind: "scan"; listing: ReadonlyMap<string, DiskFile> };

/** A sync round's input (spec/Engine.dfy `RoundInput`). */
export interface RoundInput {
  listing: ReadonlyMap<string, DiskFile>;
  unsaved: ReadonlySet<string>;
  freshDocs: readonly string[];
  /**
   * The paths the device does not sync, among those the round can look the
   * scope up at (the specification's set restricted to them, `scopePaths`):
   * the listed files, the pulled revisions' paths, and every path the
   * journal's rows and intents name.
   */
  outOfScope: ReadonlySet<string>;
}

/** The paths of a journal row that `roundInput` reads (spec/Engine.dfy `Document`). */
export interface DocumentPaths {
  readonly base: { readonly path: string } | null;
  /** Absent from journals that do not model `ahead` (the test adapter's). */
  readonly ahead?: { readonly revision: { readonly path: string } } | null;
  readonly binding: {
    readonly spelling: string;
    readonly userSpelling: string | null;
  } | null;
  readonly outbox: { readonly path: string } | null;
}

/** What `roundInput` needs of the journal: the documents it knows and the paths they name. */
export interface JournalDocuments {
  readonly documents: Readonly<Record<string, DocumentPaths>>;
  /** Absent from journals that do not model intents (the test adapter's). */
  readonly intents?: readonly { readonly intent: CoreIntentKind }[];
}

/**
 * Every path a round can look the device's scope up at: the listed files
 * (the push creates no document for an untracked file out of scope), the
 * pulled revisions' paths and every path the journal names, a held `ahead`
 * revision's above all (a revision out of scope waits as `ahead`, blocked by
 * `OutOfScope`, and a later round judges it again without pulling it again).
 * The core learns of no other path: it reads the disk only through the
 * listing, and every revision it holds is a pulled one or a row's.
 */
export function scopePaths(
  listing: Iterable<string>,
  journal: JournalDocuments,
  pulled: readonly { path: string }[],
): Set<string> {
  const paths = new Set<string>(listing);
  for (const revision of pulled) paths.add(revision.path);
  for (const document of Object.values(journal.documents)) {
    if (document.base) paths.add(document.base.path);
    if (document.ahead) paths.add(document.ahead.revision.path);
    if (document.binding) {
      paths.add(document.binding.spelling);
      if (document.binding.userSpelling !== null)
        paths.add(document.binding.userSpelling);
    }
    if (document.outbox) paths.add(document.outbox.path);
  }
  for (const { intent } of journal.intents ?? []) {
    switch (intent.kind) {
      case "apply":
        paths.add(intent.revision.path);
        break;
      case "merge":
        paths.add(intent.revision.path);
        paths.add(intent.result);
        if (intent.copy !== null) paths.add(intent.copy.path);
        break;
      case "displace":
      case "detach":
        paths.add(intent.from);
        paths.add(intent.to);
        break;
      case "commit":
      case "resync":
        break;
    }
  }
  return paths;
}

/** The paths a local event names. */
export function eventPaths(event: LocalEvent): string[] {
  return event.kind === "renamed" ? [event.from, event.to] : [event.path];
}

/**
 * How many fresh document ids a round needs (`FreshDocsSuffice`): two per
 * listed file, one per document the journal knows, and one per revision the
 * round's pull read (`|feed| − cursor`).
 */
export function freshDocsNeeded(
  listed: number,
  documents: number,
  pulled: number,
): number {
  return 2 * listed + documents + pulled;
}

function sameRead(a: Read, b: Read): boolean {
  if (a === null || b === null) return a === b;
  return a.content === b.content && a.kind === b.kind;
}

/**
 * Hands the core the vault's events, the start-up scan and each round's
 * input, one at a time and in order.
 */
export class EventCapture {
  private chain: Promise<void> = Promise.resolve();
  /** Events that arrived while a scan listed the disk; null when no scan is running. */
  private duringScan: LocalEvent[] | null = null;
  /** The scan running, if any. */
  private scanning: Promise<void> | null = null;

  constructor(
    private readonly vault: VaultReader,
    private readonly core: (input: CoreInput) => Promise<void> | void,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** The vault reported `event`. */
  onEvent(event: LocalEvent): void {
    if (this.duringScan !== null) {
      this.duringScan.push(event);
      return;
    }
    void this.enqueue(() => this.deliver(event, null));
  }

  /**
   * The start-up scan: lists the disk, hands the core the listing, then the
   * events that arrived meanwhile except those the listing made stale. A
   * call while a scan runs joins it, so no buffered event is handed over twice.
   */
  scan(): Promise<void> {
    if (this.scanning !== null) return this.scanning;
    const buffered: LocalEvent[] = [];
    this.duringScan = buffered;
    const run = this.enqueue(async () => {
      try {
        const listing = await this.listing();
        await this.core({ kind: "scan", listing });
        const keyed = this.keyed(listing);
        // Events arriving while the buffered ones are handed over are
        // buffered too, so the order the vault reported stays.
        for (let i = 0; i < buffered.length; i++) {
          const event = buffered[i];
          if (event !== undefined) await this.deliver(event, keyed);
        }
      } finally {
        this.duringScan = null;
      }
    });
    this.scanning = run;
    const done = (): void => {
      this.scanning = null;
    };
    run.then(done, done);
    return run;
  }

  /**
   * A sync round's input, read after every input handed over before it.
   * `pulled` are the revisions the round's pull read.
   */
  roundInput(
    journal: JournalDocuments,
    pulled: readonly { path: string }[],
  ): Promise<RoundInput> {
    let input: RoundInput | undefined;
    return this.enqueue(async () => {
      const listing = await this.listing();
      const unsaved = new Set(await this.vault.unsaved());
      const outOfScope = new Set<string>();
      for (const path of scopePaths(listing.keys(), journal, pulled)) {
        if (!this.vault.inScope(path)) outOfScope.add(path);
      }
      const count = freshDocsNeeded(
        listing.size,
        Object.keys(journal.documents).length,
        pulled.length,
      );
      const freshDocs: string[] = [];
      const taken = new Set<string>();
      while (freshDocs.length < count) {
        const id = this.newId();
        if (taken.has(id) || Object.hasOwn(journal.documents, id))
          throw new RangeError(`event capture: document id ${id} is not fresh`);
        taken.add(id);
        freshDocs.push(id);
      }
      input = { listing, unsaved, freshDocs, outOfScope };
    }).then(() => {
      if (input === undefined) throw new Error("event capture: no round input");
      return input;
    });
  }

  /** Resolves once every input handed over so far reached the core. */
  idle(): Promise<void> {
    return this.enqueue(() => Promise.resolve());
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task);
    // A failed input does not stop the ones after it from being handed over.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Hands the core `event` with the reads of now, unless `listing` (the scan
   * the event arrived during) already shows every path it names as it reads now.
   */
  private async deliver(
    event: LocalEvent,
    listing: ReadonlyMap<string, DiskFile> | null,
  ): Promise<void> {
    const reads: Record<string, Read> = {};
    for (const path of eventPaths(event))
      reads[path] = await this.vault.read(path);
    if (
      listing !== null &&
      Object.entries(reads).every(([path, read]) =>
        sameRead(
          read,
          listing.get(filesystemKey(path, this.vault.platform)) ?? null,
        ),
      )
    )
      return;
    await this.core({ kind: "local", event, reads });
  }

  /** The vault listing, no two names one file under `F` (`ListingDistinct`). */
  private async listing(): Promise<Map<string, DiskFile>> {
    const listing = new Map<string, DiskFile>();
    const keys = new Set<string>();
    for (const spelling of await this.vault.list()) {
      const key = filesystemKey(spelling, this.vault.platform);
      if (keys.has(key))
        throw new RangeError(
          `event capture: two listed names are one file at ${spelling}`,
        );
      keys.add(key);
      // A file gone since it was listed is not in the listing.
      const file = await this.vault.read(spelling);
      if (file !== null) listing.set(spelling, file);
    }
    return listing;
  }

  /** The listing keyed by each name's file key. */
  private keyed(listing: ReadonlyMap<string, DiskFile>): Map<string, DiskFile> {
    const keyed = new Map<string, DiskFile>();
    for (const [spelling, file] of listing)
      keyed.set(filesystemKey(spelling, this.vault.platform), file);
    return keyed;
  }
}
