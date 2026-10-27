// Types of the Dafny-compiled plugin/src/verified/gen/verified.cjs. NOT
// generated: Dafny emits no declarations, so this file is written by hand and
// scripts/verified-js.sh never touches it (TypeScript only finds it next to the
// .cjs). Only what the wrappers in plugin/src/verified/ use is declared;
// Dafny's `int` is a BigNumber.
import type BigNumber from "bignumber.js";

declare const verified: {
  Clamp: {
    __default: {
      Clamp(x: BigNumber, lo: BigNumber, hi: BigNumber): BigNumber;
    };
  };
};

export = verified;
