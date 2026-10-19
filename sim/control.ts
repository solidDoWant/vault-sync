// Client for the simulation driver's control endpoint. The driver
// (sim/simulation_test.go, `make test-sim`) runs the real server and serves
// this endpoint on loopback: it mints access tokens from its fake OIDC issuer,
// checks the server-side invariants directly in PostgreSQL, and records
// failing seeds as regression cases. Simulated clients never use it; they
// talk to the server through the public API only.

import type { Acknowledgement, Violation } from "./client";
import type { Step } from "./schedule";

/** A failing schedule, minimized, as committed under sim/regressions/. */
export interface RegressionCase {
  /** File name without extension, e.g. `seed-42`. */
  name: string;
  seed: number;
  clients: number;
  /**
   * Engines, each with a user making random changes, following
   * seededPlatforms(seed, engines). Absent in cases recorded before #22: one
   * engine without a user.
   */
  engines?: number;
  /** Why it was recorded: the violations the minimized schedule produced. */
  violations: Violation[];
  steps: Step[];
}

export class Control {
  constructor(private readonly baseUrl: string) {}

  /** An access token for a new user, so every run starts below the per-user vault and device limits. */
  async token(): Promise<string> {
    const { token } = await this.post<{ token: string }>("/token", {});
    return token;
  }

  /** The server-side invariants (§13) the vault's database state violates. */
  async check(vaultId: string, acknowledged: readonly Acknowledgement[]): Promise<Violation[]> {
    const { violations } = await this.post<{ violations: Violation[] | null }>("/check", { vaultId, acknowledged });
    return violations ?? [];
  }

  /**
   * Ages revisions past the server's retention policy and purges them with
   * the server's own retention code, as if the run had lasted that long
   * (SPEC.md §11). Of each document's aged revisions the newest, and the
   * head, stay. Returns the purged revision ids; the invariant checks expect
   * exactly these to be gone.
   */
  async purge(vaultId: string, revisionIds: readonly string[]): Promise<string[]> {
    const { purged } = await this.post<{ purged: string[] | null }>("/purge", { vaultId, revisionIds });
    return purged ?? [];
  }

  /** Records a minimized failing schedule; returns where it was written. */
  async report(regression: RegressionCase): Promise<string> {
    const { path } = await this.post<{ path: string }>("/report", regression);
    return path;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`sim control ${path}: HTTP ${String(response.status)}: ${await response.text()}`);
    return (await response.json()) as T;
  }
}
