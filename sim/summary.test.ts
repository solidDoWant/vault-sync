import { describe, expect, it } from "vitest";

import { summarize } from "./summary";

/** The value of counter `name` in a summary line. */
function counter(line: string, name: string): number | undefined {
  const match = new RegExp(`(?:^|, )${name.replace(/[()]/g, "\\$&")} (\\d+)(?:,|$)`).exec(line);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

describe("summarize", () => {
  it("counts engine pulls that resynced, among all completed pulls (#360)", () => {
    const line = summarize([
      "12: e3 pulled up to seq 4: 2 applied, 0 deferred",
      "40: e4 pulled up to seq 9: 5 applied, 1 deferred, resynced",
      "41: e3 pulled up to seq 9: 5 applied, 0 deferred, resynced",
    ]);
    expect(counter(line, "engine pulls completed")).toBe(3);
    expect(counter(line, "engine resyncs")).toBe(2);
  });

  it("counts retries of applied commits delivered after their document's head moved (#284)", () => {
    const line = summarize([
      "7: #3 c0 CommitRevision(c0.r1 c0.d1 base=-) -> ok seq=1",
      "40: #9 c0 CommitRevision(c0.r1 c0.d1 base=-) -> ok seq=1 (retry of an applied commit after its document's head moved)",
    ]);
    expect(counter(line, "retries after the head moved")).toBe(1);
  });

  it("counts notification-gated engine pulls and those the engine found not needed (#277)", () => {
    const line = summarize([
      "12: c1 starts pull; e3 starts pull if behind seq 9; e4 busy, pull skipped",
      "13: e3 pull not needed: cursor at or past seq 9",
      "20: c0 starts pull; e3 starts pull if behind seq 7; e4 starts pull",
      "21: e3 pulled up to seq 11: 2 applied, 0 deferred",
    ]);
    expect(counter(line, "notification-gated pulls")).toBe(2);
    expect(counter(line, "notification-gated pulls not needed")).toBe(1);
    expect(counter(line, "operations skipped (busy)")).toBe(1);
  });

  it("reports zero for events the trace does not show", () => {
    const line = summarize([]);
    expect(counter(line, "engine resyncs")).toBe(0);
    expect(counter(line, "retries after the head moved")).toBe(0);
  });
});
