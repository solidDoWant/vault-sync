// The per-seed summary line of the seeded suites (sim/simulation.sim.test.ts):
// how often notable events occurred in a run, to show from CI logs what a
// schedule exercised.

import { retryAfterHeadMovedMarker } from "./network";

/**
 * Each counter's name and the trace text that marks one occurrence. A counter
 * marked "each" counts every occurrence of its text, not the lines holding it:
 * one pull step logs every engine's pull on the same line.
 */
const events: readonly (readonly [string, string, "each"?])[] = [
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
  // Pulls the schedule gated on an announced seq (pullIfBehind, #277), one per engine (#661), and those the engine skipped as its cursor was there.
  ["notification-gated pulls", " starts pull if behind seq ", "each"],
  ["notification-gated pulls not needed", " pull not needed: cursor at or past seq "],
  ["engine pulls interrupted", "engine pull interrupted"],
  ["engine crashes", "restarted with its vault and journal"],
  ["tracked as unmaterializable", " as unmaterializable ("],
  // Steps that did nothing: an operation for a busy client, a delivery with nothing to deliver.
  ["operations skipped (busy)", " skipped"],
  ["idle deliveries", ": no deliverable"],
  ["engine user changes", " user "],
  ["engine pushes completed", " pushed: "],
];

/** How often notable events occurred in a run's trace, as one line. */
export function summarize(trace: readonly string[]): string {
  return events.map(([name, needle, each]) => `${name} ${String(trace.reduce((count, line) => count + (each === undefined ? Number(line.includes(needle)) : line.split(needle).length - 1), 0))}`).join(", ");
}
