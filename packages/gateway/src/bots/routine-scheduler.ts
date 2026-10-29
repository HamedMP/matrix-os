import type { BotRoutine, BotRoutineFire, BotRoutinesRepository } from "./repositories/routines.js";
import { nextBotRoutineFire } from "./routine-schedule.js";
export type RoutineRunResult = {
  status: "completed" | "failed" | "cancelled" | "uncertain" | "capacity_before_dispatch" | "accepted";
};
/** One bounded pass, one existing task executor. No outbound notification loop or new grants. */
export function createBotRoutineScheduler(deps: {
  repository: Pick<BotRoutinesRepository, "due" | "claim" | "pending" | "get" | "dispatch" | "finish" | "defer" | "recover">;
  authorize(routine: BotRoutine): Promise<boolean>;
  run(routine: BotRoutine, fire: BotRoutineFire, signal: AbortSignal): Promise<RoutineRunResult>;
  now?: () => Date;
}) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  let starting: Promise<void> | undefined,
    active: Promise<void> | undefined,
    timer: ReturnType<typeof setInterval> | undefined,
    stopped = false;
  const lifetime = new AbortController();
  async function pass() {
    const at = now();
    // A previous process can leave a still-live lease at startup; reconcile it after expiry too.
    await deps.repository.recover({
      before: at,
      now: at
    });
    for (const r of await deps.repository.due(now())) {
      if (stopped) break;
      const claimAt = now();
      try {
        await deps.repository.claim({
          ownerId: r.ownerId,
          routineId: r.routineId,
          scheduledFor: r.nextFireAt!,
          nextFireAt: nextBotRoutineFire(r.proposal.schedule, claimAt),
          now: claimAt
        });
      } catch (error: unknown) {
        console.warn("[bots] routine claim unavailable", error instanceof Error ? error.name : "UnknownError");
      }
    }
    for (const fire of await deps.repository.pending(now())) {
      if (stopped) break;
      const r = await deps.repository.get(fire.ownerId, fire.routineId);
      if (!r || r.status !== "active") {
        await deps.repository.finish({
          ownerId: fire.ownerId,
          fireId: fire.fireId,
          status: "cancelled",
          expectedStatus: "claimed",
          now: now()
        });
        continue;
      }
      let authorized = false;
      try {
        authorized = await deps.authorize(r);
      } catch (error: unknown) {
        console.warn("[bots] routine authorization unavailable", error instanceof Error ? error.name : "UnknownError");
      }
      if (!authorized) {
        await deps.repository.finish({
          ownerId: fire.ownerId,
          fireId: fire.fireId,
          status: "failed",
          failureCode: "background_not_authorized",
          expectedStatus: "claimed",
          now: now()
        });
        continue;
      }
      const dispatched = await deps.repository.dispatch({
        ownerId: fire.ownerId,
        fireId: fire.fireId,
        now: now()
      });
      if (!dispatched) continue;
      let result: RoutineRunResult;
      try {
        result = await deps.run(r, dispatched, lifetime.signal);
      } catch (error: unknown) {
        console.warn("[bots] routine outcome unavailable", error instanceof Error ? error.name : "UnknownError");
        result = {
          status: "uncertain"
        };
      }
      if (result.status === "accepted") continue;
      if (result.status === "capacity_before_dispatch" && dispatched.attempts < 3) {
        await deps.repository.defer({
          ownerId: fire.ownerId,
          fireId: fire.fireId,
          retryAfter: new Date(Date.parse(now()) + 30_000 * dispatched.attempts).toISOString(),
          now: now()
        });
      } else await deps.repository.finish({
        ownerId: fire.ownerId,
        fireId: fire.fireId,
        status: result.status === "capacity_before_dispatch" ? "failed" : result.status,
        ...(result.status === "capacity_before_dispatch" ? {
          failureCode: "capacity_exhausted"
        } : result.status === "uncertain" ? {
          failureCode: "outcome_unknown"
        } : {}),
        now: now()
      });
    }
  }
  function tick(): Promise<void> {
    if (stopped || active) return Promise.resolve();
    active = pass().finally(() => {
      active = undefined;
    });
    return active;
  }
  return {
    tick,
    start(): Promise<void> {
      if (stopped || timer) return Promise.resolve();
      starting ??= (async () => {
        const at = now();
        await deps.repository.recover({
          before: at,
          now: at
        });
        if (stopped) return;
        timer = setInterval(() => {
          void tick().catch(error => console.warn("[bots] routine pass unavailable", error instanceof Error ? error.name : "UnknownError"));
        }, 15_000);
        timer.unref();
      })().finally(() => {
        starting = undefined;
      });
      return starting;
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      lifetime.abort();
      await starting;
      await active;
    }
  };
}
