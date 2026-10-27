// Path comparison for the engine specification (#947,
// docs/design/verified-core.md §2.1). The engine compares paths in two ways
// (docs/design/engine-path-ownership.md §3.1, PO-10):
//
//   F, the file key: which spellings name one file on this device. It
//      depends on the platform's filesystem.
//   K, the server key: SPEC.md §5's pathKey, which decides server claims and
//      conflict-copy freedom.
//
// Both are abstract here: functions with stated axioms, not Unicode tables.
// Neither implies the other (§3.1: `Straße.md`/`STRASSE.md` share a K but not
// an NTFS F, `ı.md`/`I.md` share an NTFS F but not a K), so no axiom relates
// them.
abstract module PathModel {
  // A vault-relative path, by its exact spelling.
  type Path(==, !new)

  // The platform a device runs on; F depends on it (identity on posix, case
  // folding on windows/android, NFD plus case folding on macos).
  type Platform(==, !new)

  // A normalized key. Two paths are equivalent when their keys are equal,
  // so both relations below are equivalence relations by construction.
  type Key(==, !new)

  function F(platform: Platform, p: Path): Key
  function K(p: Path): Key

  // Normalization as a path: the canonical spelling a key stands for, and the
  // path a normalization maps to. Normalizing twice changes nothing.
  function FNorm(platform: Platform, p: Path): Path
  function KNorm(p: Path): Path

  lemma {:axiom} FNormalizes(platform: Platform, p: Path)
    ensures F(platform, FNorm(platform, p)) == F(platform, p)
  lemma {:axiom} FNormIdempotent(platform: Platform, p: Path)
    ensures FNorm(platform, FNorm(platform, p)) == FNorm(platform, p)
  lemma {:axiom} KNormalizes(p: Path)
    ensures K(KNorm(p)) == K(p)
  lemma {:axiom} KNormIdempotent(p: Path)
    ensures KNorm(KNorm(p)) == KNorm(p)

  predicate SameF(platform: Platform, p: Path, q: Path) { F(platform, p) == F(platform, q) }
  predicate SameK(p: Path, q: Path) { K(p) == K(q) }

  // The proper folder prefixes of a path (§3.2). Folders are implicit
  // (SPEC.md §5): a path names a folder exactly when it is an ancestor of a
  // listed file.
  function Ancestors(p: Path): set<Path>

  lemma {:axiom} AncestorsProper(p: Path)
    ensures p !in Ancestors(p)
  lemma {:axiom} AncestorsTransitive(p: Path, q: Path)
    requires q in Ancestors(p)
    ensures Ancestors(q) <= Ancestors(p)

  // F is at least as fine as disk exclusivity needs: a key class is
  // compatible with the folder relation, so whether a file lies under a
  // folder does not depend on which spelling of the folder's F class (or K
  // class) is asked about. This is what makes "collides under E" (§3.2) a
  // property of classes rather than spellings.
  lemma {:axiom} FFolderCompatible(platform: Platform, p: Path, q: Path, a: Path)
    requires SameF(platform, p, q) && a in Ancestors(p)
    ensures exists b :: b in Ancestors(q) && SameF(platform, a, b)
  lemma {:axiom} KFolderCompatible(p: Path, q: Path, a: Path)
    requires SameK(p, q) && a in Ancestors(p)
    ensures exists b :: b in Ancestors(q) && SameK(a, b)

  // §3.2: two paths collide under an equivalence if they are equivalent, or
  // one is equivalent to a folder of the other.
  predicate CollideF(platform: Platform, p: Path, q: Path) {
    SameF(platform, p, q)
    || (exists a :: a in Ancestors(p) && SameF(platform, a, q))
    || (exists a :: a in Ancestors(q) && SameF(platform, a, p))
  }
  predicate CollideK(p: Path, q: Path) {
    SameK(p, q)
    || (exists a :: a in Ancestors(p) && SameK(a, q))
    || (exists a :: a in Ancestors(q) && SameK(a, p))
  }

  // INV-9: names compared with folder segments under F and the final segment
  // exactly (a folder has one spelling on disk, #737).
  predicate SameNameModuloFolders(platform: Platform, p: Path, q: Path)

  lemma {:axiom} SameNameModuloFoldersRefl(platform: Platform, p: Path)
    ensures SameNameModuloFolders(platform, p, p)
  lemma {:axiom} SameNameModuloFoldersSameF(platform: Platform, p: Path, q: Path)
    requires SameNameModuloFolders(platform, p, q)
    ensures SameF(platform, p, q)

  lemma SameFIsEquivalence(platform: Platform, p: Path, q: Path, r: Path)
    ensures SameF(platform, p, p)
    ensures SameF(platform, p, q) ==> SameF(platform, q, p)
    ensures SameF(platform, p, q) && SameF(platform, q, r) ==> SameF(platform, p, r)
  {}

  lemma SameKIsEquivalence(p: Path, q: Path, r: Path)
    ensures SameK(p, p)
    ensures SameK(p, q) ==> SameK(q, p)
    ensures SameK(p, q) && SameK(q, r) ==> SameK(p, r)
  {}
}

// The axioms are consistent: the posix model (identity keys, paths as
// sequences of segments) satisfies all of them.
module PosixPaths refines PathModel {
  type Path = seq<string>
  type Platform = int
  type Key = seq<string>

  function F(platform: Platform, p: Path): Key { p }
  function K(p: Path): Key { p }
  function FNorm(platform: Platform, p: Path): Path { p }
  function KNorm(p: Path): Path { p }

  lemma FNormalizes(platform: Platform, p: Path) {}
  lemma FNormIdempotent(platform: Platform, p: Path) {}
  lemma KNormalizes(p: Path) {}
  lemma KNormIdempotent(p: Path) {}

  function Ancestors(p: Path): set<Path> {
    set i | 0 < i < |p| :: p[..i]
  }

  lemma AncestorsProper(p: Path) {}

  lemma AncestorsTransitive(p: Path, q: Path) {
    forall a | a in Ancestors(q) ensures a in Ancestors(p) {
      var i :| 0 < i < |q| && a == q[..i];
      var j :| 0 < j < |p| && q == p[..j];
      assert a == p[..i];
    }
  }

  lemma FFolderCompatible(platform: Platform, p: Path, q: Path, a: Path) {
    assert a in Ancestors(q);
  }
  lemma KFolderCompatible(p: Path, q: Path, a: Path) {
    assert a in Ancestors(q);
  }

  predicate SameNameModuloFolders(platform: Platform, p: Path, q: Path) { p == q }
  lemma SameNameModuloFoldersRefl(platform: Platform, p: Path) {}
  lemma SameNameModuloFoldersSameF(platform: Platform, p: Path, q: Path) {}
}
