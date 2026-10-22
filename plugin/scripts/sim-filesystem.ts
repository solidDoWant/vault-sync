// Parses SIM_FAITHFUL_FS for vitest.sim.config.ts (docs/testing/simulation.md).
// The seeded suites run on the faithful filesystem by default (refactor step
// R7d of docs/design/engine-path-ownership.md, #701); 0 opts into the folded
// vault, for replaying a seed recorded before R7. Kept out of the config so a
// unit test pins the default (#782): the folded vault also passes every seed,
// so a default that slid back would leave the simulation green while it hid
// the `F ≠ K` cases (X-18).

export const faithfulFilesystemEnv = "SIM_FAITHFUL_FS";

/**
 * Whether the seeded suites run on the faithful filesystem, given the value
 * of SIM_FAITHFUL_FS: unset, empty or `1` is the faithful filesystem, `0` the
 * folded vault. Any other value throws.
 */
export function parseFaithfulFilesystem(value: string | undefined): boolean {
  const raw = value ?? "";
  if (raw !== "" && raw !== "0" && raw !== "1") throw new Error(`${faithfulFilesystemEnv} must be 0 or 1, got ${JSON.stringify(raw)}`);
  return raw !== "0";
}
