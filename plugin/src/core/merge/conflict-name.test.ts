import { describe, expect, it } from "vitest";

import { conflictCopyPath, conflictFolderPath } from "./conflict-name";

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
