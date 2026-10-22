import { afterEach, describe, expect, it, vi } from "vitest";

import { faithfulFilesystemEnv, parseFaithfulFilesystem } from "../scripts/sim-filesystem";

// vitest.sim.config.ts decides with this which vault the seeded simulation
// suites run on. Since refactor step R7d (#701) the default is the faithful
// filesystem, which the folded vault would hide `F ≠ K` cases from (X-18 in
// docs/design/engine-path-ownership.md). The folded vault also passes every
// seed, so nothing in `make test-sim` notices a default that slid back (#782).
describe("SIM_FAITHFUL_FS", () => {
  it("is read from SIM_FAITHFUL_FS", () => {
    expect(faithfulFilesystemEnv).toBe("SIM_FAITHFUL_FS");
  });

  it("runs the seeded suites on the faithful filesystem when unset", () => {
    expect(parseFaithfulFilesystem(undefined)).toBe(true);
  });

  it("runs the seeded suites on the faithful filesystem when empty", () => {
    expect(parseFaithfulFilesystem("")).toBe(true);
  });

  it("runs the seeded suites on the faithful filesystem when 1", () => {
    expect(parseFaithfulFilesystem("1")).toBe(true);
  });

  it("runs the seeded suites on the folded vault only when 0", () => {
    expect(parseFaithfulFilesystem("0")).toBe(false);
  });

  it.each(["true", "false", "yes", "2", " 1", "0 ", "00"])("rejects %j instead of guessing", (value) => {
    expect(() => parseFaithfulFilesystem(value)).toThrow(`SIM_FAITHFUL_FS must be 0 or 1, got ${JSON.stringify(value)}`);
  });
});

// The config itself, as `make test-sim` loads it: a default that reverted
// inline in vitest.sim.config.ts, past the helper, fails here too.
const configUrl = new URL("../vitest.sim.config.ts", import.meta.url).href;

describe("vitest.sim.config.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function provided(faithful: string | undefined): Promise<boolean> {
    vi.stubEnv("VAULT_SYNC_SIM_SERVER_URL", "http://127.0.0.1:1");
    vi.stubEnv("VAULT_SYNC_SIM_LIMITED_SERVER_URL", "http://127.0.0.1:2");
    vi.stubEnv("VAULT_SYNC_SIM_CONTROL_URL", "http://127.0.0.1:3");
    vi.stubEnv("SIM_REGRESSION_DIR", "");
    vi.stubEnv(faithfulFilesystemEnv, faithful);
    vi.resetModules();
    // Not a literal specifier: the config is type-checked on its own terms,
    // not as part of the test program.
    const module = (await import(/* @vite-ignore */ configUrl)) as { default: { test: { provide: { sim: { faithfulFilesystem: boolean } } } } };
    const config = module.default;
    return config.test.provide.sim.faithfulFilesystem;
  }

  it("provides the faithful filesystem to the seeded suites when SIM_FAITHFUL_FS is unset", async () => {
    expect(await provided(undefined)).toBe(true);
  });

  it("provides the folded vault when SIM_FAITHFUL_FS is 0", async () => {
    expect(await provided("0")).toBe(false);
  });
});
