// Feasibility check for Dafny in the plugin (#946): a function with
// postconditions that `make verify` proves and that `make build` compiles to
// JavaScript (plugin/src/verified/gen/), which the plugin imports through
// plugin/src/verified/clamp.ts. It carries no engine logic.
module Clamp {
  // Clamp returns the value of [lo, hi] closest to x.
  function Clamp(x: int, lo: int, hi: int): (r: int)
    requires lo <= hi
    ensures lo <= r <= hi
    ensures lo <= x <= hi ==> r == x
    ensures x < lo ==> r == lo
    ensures hi < x ==> r == hi
  {
    if x < lo then lo else if hi < x then hi else x
  }
}
