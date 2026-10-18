// Client-generated ids for the simulation. The server requires UUIDv7 ids that
// are unique across the whole database, and one server serves every run (and
// every replay of a seed while shrinking), so ids cannot be derived from the
// seed alone. Each id is random instead, and gets a symbolic label from the
// order in which the harness generated it ("c1.d3": client 1's third
// document). Traces and decisions only ever use labels, so they replay
// identically while the raw ids differ.

import { uuidv7 } from "../plugin/src/core/uuid";

/** Generates ids and maps them to their deterministic labels. */
export class Ids {
  private readonly labels = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  /** A new id labelled `<prefix><n>`, e.g. `c0.d` gives c0.d1, c0.d2, ... */
  generate(prefix: string): string {
    const count = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, count);
    const id = uuidv7();
    this.labels.set(id, `${prefix}${String(count)}`);
    return id;
  }

  /** The label of `id`; ids the harness did not generate are shown as `?` plus a prefix of the id. */
  label(id: string): string {
    if (id === "") return "-";
    return this.labels.get(id) ?? `?${id.slice(0, 8)}`;
  }

  /** `text` with every UUID in it replaced by its label. */
  relabel(text: string): string {
    return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => this.label(id));
  }
}
