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
  return events.map(([name, needle]) => `${name} ${String(trace.filter((line) => line.includes(needle)).length)}`).join(", ");
}
