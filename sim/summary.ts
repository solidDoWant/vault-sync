// The per-seed summary line of the seeded suites (sim/simulation.sim.test.ts):
// how often notable events occurred in a run, to show from CI logs what a
// schedule exercised.

import { retryAfterHeadMovedMarker } from "./network";

/** Each counter's name and the trace text that marks one occurrence. */
const events: readonly (readonly [string, string])[] = [
  ["acknowledged", " acknowledged "],
  ["head moved", "head moved"],
  ["path taken", "path taken"],
  ["retried after network failure", "retries "],
  // A retry of an applied commit after its document's head moved: the interleaving the refused-retry check needs (#284).
  ["retries after the head moved", retryAfterHeadMovedMarker],
  ["requests lost", "request lost"],
  ["responses lost", "response lost after"],
  ["delayed", " held for "],
  ["reordered", "out of order"],
  ["partitions", " partitioned for "],
  ["crashes", " crashed and restarted"],
  ["engine pulls completed", " deferred"],
  // A pull that found the server's history diverged from its cursor and resynced (#155, #360).
  ["engine resyncs", " deferred, resynced"],
  // Pulls the schedule gated on an announced seq (pullIfBehind, #277), and those the engine skipped as its cursor was there.
  ["notification-gated pulls", " starts pull if behind seq "],
  ["notification-gated pulls not needed", " pull not needed: cursor at or past seq "],
  ["engine pulls interrupted", "engine pull interrupted"],
  ["engine crashes", "restarted with its vault and journal"],
  ["tracked as unmaterializable", " as unmaterializable ("],
  // Steps that did nothing: an operation for a busy client, a delivery with nothing to deliver.
  ["operations skipped (busy)", " skipped"],
  ["idle deliveries", ": no deliverable"],
  ["engine user changes", " user "],
  ["engine pushes completed", " pushed: "],
  // Report only (refactor step R4): bindings that disagree with the derived ownership.
  ["binding-shadow divergences", "SHADOW binding-shadow: "],
];

/** How often notable events occurred in a run's trace, as one line. */
export function summarize(trace: readonly string[]): string {
  const counts = events.map(([name, needle]) => `${name} ${String(trace.filter((line) => line.includes(needle)).length)}`);
  // Config sync changes of seeded runs (#422 item 8): an engine restarted with config sync on or off, Obsidian's writes and deletes in the config folder.
  const config = trace.filter((line) => / config sync (on|off)\b| Obsidian (writes|deletes) config /.test(line)).length;
  return [...counts, `engine commits before quiesce ${String(engineCommitsBeforeQuiesce(trace))}`, `config changes ${String(config)}`].join(", ");
}

/** The revisions the engines got acknowledged during the schedule, before the faults heal (#422 item 3). */
export function engineCommitsBeforeQuiesce(trace: readonly string[]): number {
  const quiesce = trace.findIndex((line) => line.endsWith(": quiesce"));
  return trace.slice(0, quiesce === -1 ? trace.length : quiesce).filter((line) => /^\d+: e\d+ acknowledged /.test(line)).length;
}
