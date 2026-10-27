// The fixed orders the verified round takes untracked files and commits in
// (plugin/verified/core/Push.dfy, docs/design/verified-core.md §3.8). The
// core declares `PathBefore` and `DocBefore` as abstract functions and assumes
// each is a strict total order (the axioms `PathOrder` and `DocOrder`); these
// are the implementations the compiled round's externs call, and
// core-axioms.test.ts checks both axioms against them.
//
// Both are string comparison by UTF-16 code unit, which is a strict total
// order on every JavaScript string, lone surrogates included. No locale or
// normalization takes part: two spellings that differ in any code unit are
// distinct paths to the core, and must be ordered.

/** Whether path `a` comes strictly before path `b` (`PathBefore`). */
export function pathBefore(a: string, b: string): boolean {
  return a < b;
}

/** Whether document id `a` comes strictly before document id `b` (`DocBefore`). */
export function docBefore(a: string, b: string): boolean {
  return a < b;
}
