// The verified local-event core (plugin/verified/core/LocalEvents.dfy, #948)
// made concrete so that `make verified-js` compiles it to JavaScript (#965,
// docs/design/verified-core.md §3.4). Identifiers, hashes, platforms and paths
// are strings, as in the TypeScript engine. The path keys stay what the
// specification makes them, functions known only by their axioms: here they
// are externs that the TypeScript wrapper (plugin/src/verified/local-core.ts)
// implements with the engine's own `filesystemKey` and `pathKey`, whose axioms
// plugin/src/core/pathkey/path-axioms.test.ts checks (#951). No decision logic
// lives here; this module only fixes types.
include "core/LocalEvents.dfy"

// The host functions the compiled core calls. The compiled module refers to a
// global `VerifiedPathHost` object that scripts/verified-js.sh declares and
// the TypeScript wrapper fills in before calling the core. Only `FileKey` is
// called by the compiled core; the others are declared because the path model
// needs them, and are used by proofs only.
module {:extern "VerifiedPathHost"} VerifiedPathHost {
  // filesystemKey(path, platform): which spellings name one file (F).
  function {:extern} FileKey(platform: string, p: string): string
  // pathKey(path): the server key (K).
  function {:extern} ServerKey(p: string): string
  function {:extern} FileKeyPath(platform: string, p: string): string
  function {:extern} ServerKeyPath(p: string): string
  function {:extern} Folders(p: string): set<string>
  predicate {:extern} SameNameModuloFolders(platform: string, p: string, q: string)
}

// The path model with the host's keys. Its axioms stay axioms: they are
// properties of the TypeScript implementations, checked by
// plugin/src/core/pathkey/path-axioms.test.ts (#951).
module HostPaths refines PathModel {
  import Host = VerifiedPathHost

  type Path = string
  type Platform = string
  type Key = string

  function F(platform: Platform, p: Path): Key { Host.FileKey(platform, p) }
  function K(p: Path): Key { Host.ServerKey(p) }
  function FNorm(platform: Platform, p: Path): Path { Host.FileKeyPath(platform, p) }
  function KNorm(p: Path): Path { Host.ServerKeyPath(p) }
  function Ancestors(p: Path): set<Path> { Host.Folders(p) }
  predicate SameNameModuloFolders(platform: Platform, p: Path, q: Path) { Host.SameNameModuloFolders(platform, p, q) }
}

module LocalCoreJs refines LocalCore {
  import opened P = HostPaths

  type DocId = string
  type RevId = string
  type DeviceId = string
  type IntentId = string
  type Hash = string

  // A fresh identity is one more than the largest used (as NatIdentities in
  // spec/Witnesses.dfy proves), so the specification's supply axiom holds.
  type FileIdentity = nat

  lemma Bound(used: set<nat>) returns (bound: nat)
    ensures forall i :: i in used ==> i < bound
    decreases used
  {
    if used == {} {
      bound := 0;
    } else {
      var i :| i in used;
      var rest := Bound(used - {i});
      bound := if i + 1 > rest then i + 1 else rest;
      forall j | j in used ensures j < bound {
        if j != i { assert j in used - {i}; }
      }
    }
  }

  lemma FreshIdentityExists(used: set<FileIdentity>)
    ensures exists identity: FileIdentity :: identity !in used
  {
    var bound := Bound(used);
    assert bound !in used;
  }
}
