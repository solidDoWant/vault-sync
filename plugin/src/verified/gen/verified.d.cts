// Types of the Dafny-compiled plugin/src/verified/gen/verified.cjs, written by
// hand: Dafny emits no declarations. Only what the wrappers in
// plugin/src/verified/ use is declared; Dafny's `int` is a BigNumber.
import type BigNumber from "bignumber.js";

declare const verified: {
  Clamp: {
    __default: {
      Clamp(x: BigNumber, lo: BigNumber, hi: BigNumber): BigNumber;
    };
  };
};

export = verified;
