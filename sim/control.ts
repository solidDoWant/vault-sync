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
  /** The run's RunOptions.commitRetryBackoff; absent in cases recorded before #110, which retried at once. */
  commitRetryBackoff?: number;
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

/** A scripted client's known document heads: document id to revision id. */
export interface ClientHeads {
  client: number;
  heads: Record<string, string>;
}

export class Control {
  constructor(private readonly baseUrl: string) {}

  /** An access token for a new user, so every run starts below the per-user vault and device limits. */
  async token(): Promise<string> {
    const { token } = await this.post<{ token: string }>("/token", {});
    return token;
  }

  /**
   * The server-side invariants (§13) the vault's database state violates.
   * `heads` are scripted clients' known document heads after their last
   * pull, which must be exactly the documents' heads (`feed-head`).
   */
  async check(vaultId: string, acknowledged: readonly Acknowledgement[], heads: readonly ClientHeads[] = []): Promise<Violation[]> {
    const { violations } = await this.post<{ violations: Violation[] | null }>("/check", { vaultId, acknowledged, heads });
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

  /**
   * Ages the vault's purge markers past the server's marker horizon and
   * prunes them with the server's own retention code, as if that long had
   * passed since the purges (SPEC.md §11). Returns how many it pruned.
   */
  async pruneMarkers(vaultId: string): Promise<number> {
    const { pruned } = await this.post<{ pruned: number }>("/prune-markers", { vaultId });
    return pruned;
  }

  /**
   * Makes the vault's upload sessions in progress look idle for longer than
   * the server's reclaim idle (VAULT_SYNC_BLOB_UPLOAD_RECLAIM_IDLE), as if
   * their uploaders had gone silent that long, so that a BeginBlob in the
   * vault at its session limit reclaims them (SPEC.md §6.2). Returns how
   * many it aged.
   */
  async ageUploads(vaultId: string): Promise<number> {
    const { aged } = await this.post<{ aged: number }>("/age-uploads", { vaultId });
    return aged;
  }

  /** Backs up the vault's change history in the database, for restore; returns the vault's head_seq then. */
  async snapshot(vaultId: string): Promise<bigint> {
    const { headSeq } = await this.post<{ headSeq: number }>("/snapshot", { vaultId });
    return BigInt(headSeq);
  }

  /**
   * Restores the vault's last snapshot, as a restore of a database backup
   * would (SPEC.md §8): later revisions are gone and head_seq is back, so
   * the next commits reuse seqs clients have applied. Returns head_seq.
   */
  async restore(vaultId: string): Promise<bigint> {
    const { headSeq } = await this.post<{ headSeq: number }>("/restore", { vaultId });
    return BigInt(headSeq);
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
