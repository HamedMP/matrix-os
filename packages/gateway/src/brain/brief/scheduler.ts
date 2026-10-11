/**
 * The daily brief job: one pass shortly after start (the runner skips scopes whose brief is fresh), then every day
 * at BRAIN_BRIEF_SCHEDULE.hourUtc. Timers are unref'd; stop() aborts a running pass and waits for it briefly.
 * Also the scope lister the runner reads (live sources, stalest brief first; read-only).
 */
import { sql, type Kysely } from "kysely";
import {
  BRAIN_BRIEF_SCHEDULE, BRAIN_SCHEDULED_SCOPES_MAX, type BrainBackgroundJob, type BrainBriefRunner,
  type BrainScopeLister,
} from "../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import { DAY_MS } from "./time.js";

export const BRIEF_JOB_NAME = "brain-brief";
/** Delay of the first pass after start, so startup work finishes first. */
export const BRIEF_START_DELAY_MS = 60_000;
/** How long stop() waits for an aborted pass to settle. */
export const BRIEF_STOP_WAIT_MS = 5_000;

/** Milliseconds from `now` to the next hourUtc:00 UTC (a full day when it is exactly that time). */
export function msUntilNextRun(now: Date, hourUtc: number = BRAIN_BRIEF_SCHEDULE.hourUtc): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc);
  const wait = next - now.getTime();
  return wait > 0 ? wait : wait + DAY_MS;
}

export function createBrainBriefScopeLister(db: Kysely<BrainDatabase>): BrainScopeLister {
  return {
    /** Those whose newest stored brief is oldest (none: first) lead, so a pass cut short never starves the rest. */
    async listActiveScopes(ownerId: string, limit: number): Promise<readonly BrainScopeKey[]> {
      const bounded = Math.max(1, Math.min(Math.trunc(limit) || 1, BRAIN_SCHEDULED_SCOPES_MAX));
      const { rows } = await sql<{ scope_id: string }>`
        SELECT s.scope_id FROM (SELECT DISTINCT scope_id FROM brain_sources WHERE owner_id = ${ownerId}
          AND deleted_at IS NULL) s
        ORDER BY (SELECT max(b.generated_at) FROM brain_brief_briefs b WHERE b.owner_id = ${ownerId}
          AND b.scope_id = s.scope_id) NULLS FIRST, s.scope_id LIMIT ${bounded}`.execute(db);
      return rows.map((row) => ({ ownerId, scopeId: row.scope_id }));
    },
  };
}

export function createBrainBriefScheduler(deps: {
  readonly runner: BrainBriefRunner; readonly ownerId: string; readonly scopes: BrainScopeLister;
  readonly now?: () => Date;
}): BrainBackgroundJob {
  const clock = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let started = false;

  function arm(delayMs: number): void {
    timer = setTimeout(() => {
      timer = null;
      running = pass().finally(() => {
        running = null;
        if (started && timer === null) arm(msUntilNextRun(clock()));
      });
    }, delayMs);
    timer.unref();
  }

  async function pass(): Promise<void> {
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(BRAIN_BRIEF_SCHEDULE.passBudgetMs)]);
    try {
      const summary = await deps.runner({ ownerId: deps.ownerId, now: clock(), scopes: deps.scopes, signal });
      if (summary.failed > 0) console.error(`[brain-brief] Pass finished with ${summary.failed} failed scopes`);
    } catch (error: unknown) {
      console.error("[brain-brief] Pass failed:", error instanceof Error ? error.name : "UnknownError");
    } finally {
      controller = null;
    }
  }

  return {
    name: BRIEF_JOB_NAME,
    start() {
      if (started) return;
      started = true;
      if (timer === null && running === null) arm(BRIEF_START_DELAY_MS);
    },
    async stop() {
      started = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      controller?.abort();
      const pending = running;
      if (pending === null) return;
      let wait: NodeJS.Timeout | undefined;
      await Promise.race([pending, new Promise<void>((resolve) => {
        wait = setTimeout(resolve, BRIEF_STOP_WAIT_MS);
        wait.unref();
      })]);
      clearTimeout(wait);
    },
  };
}
