import BigNumber from "bignumber.js";

import verified from "./gen/verified.cjs";

/**
 * The value of [lo, hi] closest to x, computed by the Dafny-verified
 * plugin/verified/Clamp.dfy (compiled to JavaScript by `make build`). Its
 * proven postconditions: the result is in [lo, hi], and it is x when x is.
 * The Dafny function's precondition (lo <= hi) and its integer domain are
 * checked here, because compiled Dafny trusts its callers.
 */
export function clamp(x: number, lo: number, hi: number): number {
  for (const value of [x, lo, hi]) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`clamp: ${String(value)} is not a safe integer`);
    }
  }
  if (lo > hi) {
    throw new RangeError(`clamp: lo (${String(lo)}) is greater than hi (${String(hi)})`);
  }
  return verified.Clamp.__default.Clamp(new BigNumber(x), new BigNumber(lo), new BigNumber(hi)).toNumber();
}
