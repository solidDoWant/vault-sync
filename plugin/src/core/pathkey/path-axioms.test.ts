// The path comparison axioms of the engine specification
// (plugin/verified/spec/Paths.dfy, docs/design/verified-core.md §2.1) hold
// for the TypeScript implementations the engine runs (#951). The
// specification takes `F` and `K` as abstract functions with axioms; here
// each `lemma {:axiom}` has exactly one property test, named after it
// (scripts/path-axioms_check.sh fails `make test` otherwise), over every
// platform's `F`:
//
//   F(platform, p)            filesystemKey(p, platform)
//   K(p)                      pathKey(p)
//   FNorm(platform, p)        filesystemKey(p, platform), the key as a path
//   KNorm(p)                  pathKey(p), likewise
//   Ancestors(p)              PathSpace.ancestors(p)
//   SameNameModuloFolders     PathSpace.sameButFolderSpelling
//
// An axiom a platform turns out to violate is a finding for the
// specification's design process, not something to patch here.
//
// Paths are drawn from segments that mix arbitrary code points with the
// spellings that make path comparison hard: Turkish dotted and dotless i,
// German ß and ẞ, combining marks (U+0345 among them), NFC/NFD pairs,
// compatibility characters and Windows reserved names. Equivalent pairs come
// from respelling a path (case changes per character, NFC or NFD, ß to SS)
// so that the axioms' preconditions hold often.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { PathSpace } from "../engine/pathspace";
import { filesystemKey, type PathPlatform } from "../vaultpath/platform";
import { pathKey } from "./pathkey";

const platforms: readonly PathPlatform[] = [
  "posix",
  "android",
  "windows",
  "macos",
];
const runs = { numRuns: 2000, seed: 951 };

const F = (platform: PathPlatform, path: string) =>
  filesystemKey(path, platform);
const K = (path: string) => pathKey(path);
const FNorm = F;
const KNorm = K;
const ancestors = (path: string) => new PathSpace().ancestors(path);

const hardPieces = [
  "ı",
  "I",
  "i",
  "İ",
  "i̇",
  "ß",
  "ẞ",
  "SS",
  "ss",
  "ſ",
  "é",
  "é",
  "É",
  "É",
  "Å",
  "Å",
  "Å",
  "K",
  "K",
  "Ω",
  "Ω",
  "ͅ",
  "ᾴ",
  "ᾴ",
  "ᾳ",
  "ΐ",
  "Σ",
  "σ",
  "ς",
  "ǅ",
  "ǆ",
  "Ǆ",
  "ﬁ",
  "ﬀ",
  "가",
  "가",
  "̇",
  "́",
  "𐐨",
  "𐐀",
  "CON",
  "con",
  "nul",
  "Nul.txt",
  "COM¹",
  "lpt3",
  "CONIN$",
  "AUX .md",
  ".",
  " ",
  ".md",
  "a",
  "b",
];

const piece = fc.oneof(
  fc.constantFrom(...hardPieces),
  fc.string({ unit: "binary", minLength: 1, maxLength: 2 }),
);
const segment = fc
  .array(piece, { minLength: 1, maxLength: 4 })
  .map((pieces) => pieces.join("").replaceAll("/", ""))
  .filter((text) => text !== "");
const path = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join("/"));
const platform = fc.constantFrom(...platforms);

/** Respells `text` one code point at a time (as is, upper or lower case), then optionally NFC/NFD and ß as SS. */
const respelling = (text: string) =>
  fc
    .tuple(
      fc.array(fc.constantFrom(0, 1, 2), {
        minLength: Array.from(text).length,
        maxLength: Array.from(text).length,
      }),
      fc.constantFrom("none", "NFC", "NFD"),
      fc.boolean(),
    )
    .map(([cases, form, sharpS]) => {
      let out = Array.from(text)
        .map((char, index) =>
          cases[index] === 1
            ? char.toUpperCase()
            : cases[index] === 2
              ? char.toLowerCase()
              : char,
        )
        .join("");
      if (form !== "none") out = out.normalize(form);
      if (sharpS) out = out.replaceAll("ß", "SS");
      return out;
    });

/** `text` with its first folder merged into the next segment: the same characters, other folders. */
const merged = (text: string) => text.replace("/", "");

/**
 * A path and another spelling of it: a respelling, its key under `F` or `K`
 * read as a path, or (so that a key which loses the folders fails) the path
 * with its folders moved.
 */
const pathPair = fc
  .tuple(platform, path)
  .chain(([device, original]) =>
    fc.tuple(
      fc.constant(device),
      fc.constant(original),
      fc.oneof(
        respelling(original),
        fc.constant(F(device, original)),
        fc.constant(K(original)),
        fc.constant(merged(original)),
      ),
    ),
  );

/** Runs `property`, counting the runs whose precondition held; fails if too few did to mean anything. */
function assertWithPrecondition<T>(
  arbitrary: fc.Arbitrary<T>,
  property: (value: T) => boolean | undefined,
) {
  let held = 0;
  fc.assert(
    fc.property(arbitrary, (value) => {
      const result = property(value);
      if (result === undefined) return true;
      held++;
      return result;
    }),
    runs,
  );
  expect(held).toBeGreaterThan(runs.numRuns / 10);
}

describe("path comparison axioms (plugin/verified/spec/Paths.dfy)", () => {
  it("FNormalizes", () => {
    fc.assert(
      fc.property(
        platform,
        path,
        (device, p) => F(device, FNorm(device, p)) === F(device, p),
      ),
      runs,
    );
  });

  it("FNormIdempotent", () => {
    fc.assert(
      fc.property(
        platform,
        path,
        (device, p) => FNorm(device, FNorm(device, p)) === FNorm(device, p),
      ),
      runs,
    );
  });

  it("KNormalizes", () => {
    fc.assert(
      fc.property(path, (p) => K(KNorm(p)) === K(p)),
      runs,
    );
  });

  it("KNormIdempotent", () => {
    fc.assert(
      fc.property(path, (p) => KNorm(KNorm(p)) === KNorm(p)),
      runs,
    );
  });

  it("AncestorsProper", () => {
    fc.assert(
      fc.property(path, (p) => !ancestors(p).includes(p)),
      runs,
    );
  });

  it("AncestorsTransitive", () => {
    fc.assert(
      fc.property(path, (p) => {
        const folders = ancestors(p);
        return folders.every((q) =>
          ancestors(q).every((a) => folders.includes(a)),
        );
      }),
      runs,
    );
  });

  it("FFolderCompatible", () => {
    assertWithPrecondition(pathPair, ([device, p, q]) => {
      if (F(device, p) !== F(device, q) || ancestors(p).length === 0)
        return undefined;
      return ancestors(p).every((a) =>
        ancestors(q).some((b) => F(device, a) === F(device, b)),
      );
    });
  });

  it("KFolderCompatible", () => {
    assertWithPrecondition(pathPair, ([, p, q]) => {
      if (K(p) !== K(q) || ancestors(p).length === 0) return undefined;
      return ancestors(p).every((a) => ancestors(q).some((b) => K(a) === K(b)));
    });
  });

  it("SameNameModuloFoldersRefl", () => {
    fc.assert(
      fc.property(platform, path, (device, p) =>
        new PathSpace({ platform: device }).sameButFolderSpelling(p, p),
      ),
      runs,
    );
  });

  it("SameNameModuloFoldersSameF", () => {
    // Respell only the folders: the relation keeps the final segment exact.
    const folderRespelling = fc
      .tuple(platform, path, segment)
      .chain(([device, folder, name]) =>
        fc.tuple(
          fc.constant(device),
          fc.constant(`${folder}/${name}`),
          fc
            .oneof(respelling(folder), fc.constant(F(device, folder)))
            .map((other) => `${other}/${name}`),
        ),
      );
    assertWithPrecondition(folderRespelling, ([device, p, q]) => {
      if (!new PathSpace({ platform: device }).sameButFolderSpelling(p, q))
        return undefined;
      return F(device, p) === F(device, q);
    });
  });
});

describe("path comparison lemmas the specification proves from the axioms", () => {
  // Proven in Paths.dfy because both relations are key equality; these
  // check that the engine's predicates are that key equality.
  const triple = fc
    .tuple(platform, path)
    .chain(([device, p]) =>
      fc.tuple(
        fc.constant(device),
        fc.constant(p),
        respelling(p),
        respelling(p),
      ),
    );

  it("SameFIsEquivalence", () => {
    fc.assert(
      fc.property(triple, ([device, p, q, r]) => {
        const space = new PathSpace({ platform: device });
        const oneFile = (a: string, b: string) => space.oneFile(a, b);
        expect(oneFile(p, p)).toBe(true);
        expect(oneFile(p, q)).toBe(oneFile(q, p));
        if (oneFile(p, q) && oneFile(q, r)) expect(oneFile(p, r)).toBe(true);
        expect(oneFile(p, q)).toBe(F(device, p) === F(device, q));
      }),
      runs,
    );
  });

  it("SameKIsEquivalence", () => {
    fc.assert(
      fc.property(triple, ([device, p, q, r]) => {
        const space = new PathSpace({ platform: device });
        const sameK = (a: string, b: string) =>
          space.serverKey(a) === space.serverKey(b);
        expect(sameK(p, p)).toBe(true);
        expect(sameK(p, q)).toBe(sameK(q, p));
        if (sameK(p, q) && sameK(q, r)) expect(sameK(p, r)).toBe(true);
      }),
      runs,
    );
  });
});

describe("F and K are not related (Paths.dfy states no axiom between them)", () => {
  it("shares a K but not an F: Straße.md and STRASSE.md", () => {
    expect(K("Straße.md")).toBe(K("STRASSE.md"));
    for (const device of platforms)
      expect(F(device, "Straße.md")).not.toBe(F(device, "STRASSE.md"));
  });

  it("shares an F but not a K: ı.md and I.md on case-insensitive platforms", () => {
    expect(K("ı.md")).not.toBe(K("I.md"));
    for (const device of ["windows", "android", "macos"] as const)
      expect(F(device, "ı.md")).toBe(F(device, "I.md"));
  });
});
