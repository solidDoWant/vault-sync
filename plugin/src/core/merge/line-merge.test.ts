import fc from "fast-check";
import { loadAll } from "js-yaml";
import { describe, expect, it } from "vitest";

import { blobMergeFor } from "./file-merge";
import { lineMergeExtensions, maxLineMergeBytes, mergeLines } from "./line-merge";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function merge(extension: string, base: string, local: string, remote: string): string | null {
  const merged = mergeLines(extension, encoder.encode(base), encoder.encode(local), encoder.encode(remote));
  return merged === null ? null : decoder.decode(merged);
}

const csv = "id,name,qty\n1,apple,3\n2,pear,5\n3,plum,7\n4,fig,9\n";

describe("mergeLines", () => {
  it("merges CSV edits to different rows", () => {
    const local = csv.replace("1,apple,3", "1,apple,4");
    const remote = csv.replace("4,fig,9", "4,fig,10");
    expect(merge("csv", csv, local, remote)).toBe("id,name,qty\n1,apple,4\n2,pear,5\n3,plum,7\n4,fig,10\n");
  });

  it("falls back on an overlapping CSV edit", () => {
    expect(merge("csv", csv, csv.replace("2,pear,5", "2,pear,6"), csv.replace("2,pear,5", "2,pear,8"))).toBeNull();
  });

  it("falls back when both sides insert different lines at the same place", () => {
    expect(merge("txt", "a\nb\n", "a\nx\nb\n", "a\ny\nb\n")).toBeNull();
  });

  it("falls back when a merged YAML or TOML file no longer parses", () => {
    const yaml = "a: 1\n\nb: 2\n\nc: 3\n";
    expect(merge("yaml", yaml, yaml.replace("a: 1", "d: 1"), yaml.replace("c: 3", "d: 3"))).toBeNull();
    expect(merge("yml", yaml, yaml.replace("a: 1", "a: 9"), yaml.replace("c: 3", "c: 8"))).toBe("a: 9\n\nb: 2\n\nc: 8\n");
    const toml = 'a = 1\n\nb = 2\n\nc = 3\n';
    expect(merge("toml", toml, toml.replace("a = 1", "d = 1"), toml.replace("c = 3", "d = 3"))).toBeNull();
    expect(merge("toml", toml, toml.replace("a = 1", "a = 9"), toml.replace("c = 3", "c = 8"))).toBe("a = 9\n\nb = 2\n\nc = 8\n");
  });

  it("falls back when a side is not UTF-8", () => {
    const invalid = new Uint8Array([0x61, 0x0a, 0xff, 0x0a]);
    expect(mergeLines("txt", encoder.encode("a\n"), invalid, encoder.encode("a\nb\n"))).toBeNull();
  });

  it("merges files of exactly the size limit and falls back one byte above", () => {
    const filler = "x".repeat(maxLineMergeBytes - 7);
    const at = `a\n\n${filler}\n\nb\n`;
    expect(encoder.encode(at).length).toBe(maxLineMergeBytes);
    expect(merge("txt", at, at.replace("a\n", "A\n"), at.replace("b\n", "B\n"))).toBe(`A\n\n${filler}\n\nB\n`);
    const above = `a\n\n${filler}x\n\nb\n`;
    expect(merge("txt", above, above.replace("a\n", "A\n"), above.replace("b\n", "B\n"))).toBeNull();
  });
});

describe("the line-merged extensions", () => {
  it("are the plain-text, source and markup types, each picked by a path's extension in any case", () => {
    const expected = ["txt", "csv", "tsv", "css", "js", "ts", "py", "sh", "html", "xml", "tex", "org", "rst", "yaml", "yml", "toml"];
    expect([...lineMergeExtensions].sort()).toEqual([...expected].sort());
    for (const extension of expected) {
      const strategy = blobMergeFor(`folder/File.${extension.toUpperCase()}`);
      expect(strategy).not.toBeNull();
      expect(strategy?.(encoder.encode("# a\n\n# b\n"), encoder.encode("# A\n\n# b\n"), encoder.encode("# a\n\n# B\n"))).toEqual(encoder.encode("# A\n\n# B\n"));
    }
  });

  it("leave binary and other types to the blob rule", () => {
    for (const path of ["image.png", "doc.pdf", "archive.zip", "no-extension", "dir.txt/file"]) expect(blobMergeFor(path)).toBeNull();
  });
});

const lineArbitrary = (choices: string[]) => fc.array(fc.constantFrom(...choices), { maxLength: 6 }).map((lines) => lines.join(""));

describe("mergeLines properties", () => {
  const text = lineArbitrary(["a\n", "b\n", "c\n", "d"]);

  it("merge(base, x, base) = x and merge(base, x, x) = x", () => {
    fc.assert(
      fc.property(text, text, (b, x) => {
        expect(merge("txt", b, x, b)).toBe(x);
        expect(merge("txt", b, x, x)).toBe(x);
      }),
    );
  });

  it("is symmetric", () => {
    fc.assert(
      fc.property(text, text, text, (b, x, y) => {
        expect(merge("txt", b, x, y)).toBe(merge("txt", b, y, x));
      }),
      { numRuns: 1000 },
    );
  });

  it("every merged YAML result parses", () => {
    const yaml = lineArbitrary(["a: 1\n", "b: [\n", "]\n", "c: 2\n", "\n"]);
    fc.assert(
      fc.property(yaml, yaml, yaml, (b, x, y) => {
        const merged = merge("yaml", b, x, y);
        if (merged !== null) expect(() => loadAll(merged)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });
});

