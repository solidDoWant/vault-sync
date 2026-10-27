import { describe, expect, it } from "vitest";

import { conflictCopyPath, conflictFolderPath, copyCandidate } from "./conflict-name";

const date = new Date(Date.UTC(2026, 9, 18, 4, 5, 6));
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("conflictCopyPath", () => {
  it("names the copy after the device and the UTC time, keeping folder and extension", () => {
    expect(conflictCopyPath("notes/Plan.md", "Pixel 7", date)).toBe("notes/Plan (conflict Pixel 7 2026-10-18 040506).md");
    expect(conflictCopyPath("image.final.png", "laptop", date)).toBe("image.final (conflict laptop 2026-10-18 040506).png");
  });

  it("treats a name without a dot, or with only a leading dot, as having no extension", () => {
    expect(conflictCopyPath("README", "laptop", date)).toBe("README (conflict laptop 2026-10-18 040506)");
    expect(conflictCopyPath("dir/.gitignore", "laptop", date)).toBe("dir/.gitignore (conflict laptop 2026-10-18 040506)");
  });

  it("names a folder as a conflict copy, without splitting an extension off its name, keeping the path inside it", () => {
    expect(conflictFolderPath("notes", "c.md", "laptop", date)).toBe("notes (conflict laptop 2026-10-18 040506)/c.md");
    expect(conflictFolderPath("a/v1.2", "sub/c.md", "laptop", date, 2)).toBe("a/v1.2 (conflict laptop 2026-10-18 040506 2)/sub/c.md");
  });

  it("shortens a folder's conflict name so the whole path fits, or gives up", () => {
    const rest = `${"r".repeat(250)}/`.repeat(15) + "c.md";
    const named = conflictFolderPath("f".repeat(200), rest, "laptop", date);
    expect(named).not.toBeNull();
    expect(bytes(named ?? "")).toBeLessThanOrEqual(4096);
    expect(named?.endsWith(`/${rest}`)).toBe(true);
    expect(conflictFolderPath("f", `${"r".repeat(250)}/`.repeat(16) + `${"c".repeat(60)}.md`, "laptop", date) === null).toBe(true);
  });

  it("adds a counter from the second attempt on", () => {
    expect(conflictCopyPath("a.md", "laptop", date, 2)).toBe("a (conflict laptop 2026-10-18 040506 2).md");
  });

  it("reduces the device name to characters legal in a file name on every platform", () => {
    expect(conflictCopyPath("a.md", "my/pc\\:*?\"<>|\u0007 (work)", date)).toBe("a (conflict my-pc--------- -work- 2026-10-18 040506).md");
    expect(conflictCopyPath("a.md", "  \t ", date)).toBe("a (conflict device 2026-10-18 040506).md");
  });

  it("shortens the name so the file name is at most 255 bytes, and only when it must", () => {
    const suffix = " (conflict laptop 2026-10-18 040506).md";
    const longest = "n".repeat(255 - bytes(suffix));
    expect(conflictCopyPath(`dir/${longest}.md`, "laptop", date)).toBe(`dir/${longest}${suffix}`);
    // One byte more and the name loses exactly one character.
    expect(conflictCopyPath(`dir/${longest}x.md`, "laptop", date)).toBe(`dir/${longest}${suffix}`);
    // Never splits a multi-byte character.
    const copy = conflictCopyPath(`${"é".repeat(200)}.md`, "laptop", date);
    expect(copy).toMatch(/^é+ \(conflict laptop 2026-10-18 040506\)\.md$/);
    expect(bytes(copy ?? "")).toBeLessThanOrEqual(255);
    expect(bytes(copy ?? "")).toBeGreaterThan(253);
  });

  it("keeps the whole path within the server's 4096-byte limit", () => {
    const folder = `${Array.from({ length: 16 }, () => "f".repeat(250)).join("/")}/`; // 4016 bytes
    const name = "n".repeat(100);
    const copy = conflictCopyPath(`${folder}${name}.md`, "laptop", date);
    expect(copy).not.toBeNull();
    expect(bytes(copy ?? "")).toBe(4096);
    expect(copy?.startsWith(`${folder}n`)).toBe(true);
    expect(copy?.endsWith(" (conflict laptop 2026-10-18 040506).md")).toBe(true);
  });

  it("returns null when no copy name fits, so the caller keeps the local version in place", () => {
    const folder = `${Array.from({ length: 16 }, () => "f".repeat(250)).join("/")}/${"g".repeat(60)}/`;
    expect(conflictCopyPath(`${folder}a.md`, "laptop", date)).toBeNull();
  });
});

describe("copyCandidate (the verified core's CopyCandidate)", () => {
  const naming = { deviceName: "Pixel 7", date };

  it("names the copy `<name> (conflict <device> <date>).<ext>` in the same folder, with the UTC date as YYYY-MM-DD HHmmss", () => {
    expect(copyCandidate("notes/Plan.md", null, 1, naming)).toBe("notes/Plan (conflict Pixel 7 2026-10-18 040506).md");
    // Another time zone's midnight is still the UTC date.
    expect(copyCandidate("a.md", null, 1, { deviceName: "pc", date: new Date("2026-01-01T00:30:09+02:00") })).toBe("a (conflict pc 2025-12-31 223009).md");
  });

  it("cleans the device name: whitespace runs made one space, forbidden characters and parentheses made -, trimmed, cut to 40 characters, `device` if empty", () => {
    expect(copyCandidate("a.md", null, 1, { deviceName: " my\t\tpc/\\:*?\"<>|\u0001(x) ", date })).toBe("a (conflict my pc-----------x- 2026-10-18 040506).md");
    expect(copyCandidate("a.md", null, 1, { deviceName: "d".repeat(40), date })).toBe(`a (conflict ${"d".repeat(40)} 2026-10-18 040506).md`);
    expect(copyCandidate("a.md", null, 1, { deviceName: "d".repeat(41), date })).toBe(`a (conflict ${"d".repeat(40)} 2026-10-18 040506).md`);
    expect(copyCandidate("a.md", null, 1, { deviceName: " () ", date })).toBe("a (conflict -- 2026-10-18 040506).md");
    expect(copyCandidate("a.md", null, 1, { deviceName: "\t ", date })).toBe("a (conflict device 2026-10-18 040506).md");
  });

  it("adds the counter n from 2 on, and none for 1", () => {
    expect(copyCandidate("a.md", null, 1, naming)).toBe("a (conflict Pixel 7 2026-10-18 040506).md");
    expect(copyCandidate("a.md", null, 2, naming)).toBe("a (conflict Pixel 7 2026-10-18 040506 2).md");
    expect(copyCandidate("a.md", null, 100, naming)).toBe("a (conflict Pixel 7 2026-10-18 040506 100).md");
    expect(() => copyCandidate("a.md", null, 0, naming)).toThrow(RangeError);
  });

  it("puts the suffix on the folder the core names (the outermost held one, #359), keeping the rest of the path", () => {
    expect(copyCandidate("Notes/C.md", "Notes", 1, naming)).toBe("Notes (conflict Pixel 7 2026-10-18 040506)/C.md");
    expect(copyCandidate("a/b/c.md", "a", 2, naming)).toBe("a (conflict Pixel 7 2026-10-18 040506 2)/b/c.md");
    expect(copyCandidate("a/v1.2/c.md", "a/v1.2", 1, naming)).toBe("a/v1.2 (conflict Pixel 7 2026-10-18 040506)/c.md");
    expect(() => copyCandidate("ab/c.md", "a", 1, naming)).toThrow(RangeError);
  });

  it("shortens `<name>` from its end until the file name fits 255 bytes, and only when it must", () => {
    const suffix = " (conflict Pixel 7 2026-10-18 040506).md";
    const longest = "n".repeat(255 - bytes(suffix));
    expect(copyCandidate(`dir/${longest}.md`, null, 1, naming)).toBe(`dir/${longest}${suffix}`);
    expect(copyCandidate(`dir/${longest}xy.md`, null, 1, naming)).toBe(`dir/${longest}${suffix}`);
    const folderSuffix = " (conflict Pixel 7 2026-10-18 040506)";
    const folder = "f".repeat(255 - bytes(folderSuffix));
    expect(copyCandidate(`${folder}z/c.md`, `${folder}z`, 1, naming)).toBe(`${folder}${folderSuffix}/c.md`);
  });

  it("keeps §6.2's 4096-byte path limit", () => {
    const folder = `${Array.from({ length: 16 }, () => "f".repeat(250)).join("/")}/`;
    const copy = copyCandidate(`${folder}${"n".repeat(100)}.md`, null, 1, naming);
    expect(bytes(copy ?? "")).toBe(4096);
    expect(copy?.endsWith(" (conflict Pixel 7 2026-10-18 040506).md")).toBe(true);
  });

  it("keeps the platform's limits: Windows' 259-character path, root included", () => {
    const rules = { platform: "windows" as const, root: "C:\\v" };
    const suffix = " (conflict Pixel 7 2026-10-18 040506).md";
    // "C:\v" and the separator take 5 of the 259 characters.
    const fits = "n".repeat(259 - 5 - "dir/".length - suffix.length);
    expect(copyCandidate(`dir/${fits}.md`, null, 1, { ...naming, rules })).toBe(`dir/${fits}${suffix}`);
    expect(copyCandidate(`dir/${fits}x.md`, null, 1, { ...naming, rules })).toBe(`dir/${fits}${suffix}`);
    expect(copyCandidate(`dir/${fits}x.md`, null, 1, naming)).toBe(`dir/${fits}x${suffix}`);
  });

  it("gives no name when no shortened name fits", () => {
    const folder = `${Array.from({ length: 16 }, () => "f".repeat(250)).join("/")}/${"g".repeat(60)}/`;
    expect(copyCandidate(`${folder}a.md`, null, 1, naming)).toBeNull();
    const rules = { platform: "windows" as const, root: `C:\\${"r".repeat(250)}` };
    expect(copyCandidate("a.md", null, 1, { ...naming, rules })).toBeNull();
  });
});
