import { describe, expect, it } from "vitest";

import { summarize } from "./summary";

/** The value of counter `name` in a summary line. */
function counter(line: string, name: string): number | undefined {
  const match = new RegExp(`(?:^|, )${name.replace(/[()]/g, "\\$&")} (\\d+)(?:,|$)`).exec(line);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

describe("summarize", () => {
  it("counts the engines' commits before the faults heal, and config sync changes (#422)", () => {
    const line = summarize([
      "10: e3 acknowledged e3.x2 seq=4 base=-",
      "11: c0 create c0.d1 acknowledged c0.r1 seq=5",
      "12: e3 config sync on (themes, snippets), engine restarted",
      "13: e4 Obsidian writes config hotkeys.json (20 B)",
      "14: e4 Obsidian deletes config hotkeys.json",
      "15: e4 config sync off, engine restarted",
      "900: quiesce",
      "900: e4 acknowledged e4.x3 seq=6 base=-",
    ]);
    expect(counter(line, "engine commits before quiesce")).toBe(1);
    expect(counter(line, "config changes")).toBe(4);
    expect(counter(line, "acknowledged")).toBe(3);
  });

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
