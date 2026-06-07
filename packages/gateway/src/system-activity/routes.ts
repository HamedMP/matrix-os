import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { ActivityConflictError, ActivityForbiddenError } from "./types.js";
import type {
  ActivityCollectOptions,
  ActivitySnapshot,
  AutoCleanupPolicy,
  CleanupAction,
  CleanupActionResult,
  CleanupActionType,
  CleanupHistoryEntry,
} from "./types.js";

export interface SystemActivityRouteDeps {
  collect(options: ActivityCollectOptions): Promise<ActivitySnapshot>;
  executeAction?(action: CleanupAction): Promise<CleanupActionResult>;
  readPolicy?(): Promise<AutoCleanupPolicy>;
  savePolicy?(policy: Omit<AutoCleanupPolicy, "lastUpdatedAt">): Promise<AutoCleanupPolicy>;
  readHistory?(query: { limit: number; cursor?: string }): Promise<{
    entries: CleanupHistoryEntry[];
    nextCursor: string | null;
  }>;
}

const ActionTypeSchema = z.enum([
  "stop_stale_app_server",
  "close_stale_terminal_session",
  "restart_idle_code_server",
  "clean_cache_scope",
  "prune_old_bundle",
]);

const conservativeAutomaticTypes = new Set<CleanupActionType>([
  "stop_stale_app_server",
  "clean_cache_scope",
  "prune_old_bundle",
]);

const QueryBooleanSchema = z.union([z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((value) => value === undefined ? true : value === true || value === "true");

const ActivityQuerySchema = z.object({
  processLimit: z.coerce.number().int().min(1).max(100).default(25),
  includeSuggestions: QueryBooleanSchema,
});

const ActionBodySchema = z.object({
  type: ActionTypeSchema,
  candidateId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
  confirmationToken: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
  mode: z.enum(["manual", "automatic"]).default("manual"),
});

const PolicyBodySchema = z.object({
  enabled: z.boolean(),
  allowedTypes: z.array(ActionTypeSchema).max(8),
  gracePeriodSeconds: z.number().int().min(300).max(86_400),
  maxActionsPerHour: z.number().int().min(1).max(12),
}).superRefine((policy, ctx) => {
  for (const type of policy.allowedTypes) {
    if (!conservativeAutomaticTypes.has(type)) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedTypes"],
        message: "manual_only_action",
      });
    }
  }
});

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
});

export function createSystemActivityRoutes(deps: SystemActivityRouteDeps): Hono {
  const app = new Hono();
  const mutationLimit = bodyLimit({ maxSize: 16_384 });
  const automaticBudget = { inFlight: 0 };

  app.get("/activity", async (c) => {
    try {
      const query = ActivityQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
      return c.json(await deps.collect(query));
    } catch (err) {
      return safeError(c, err, "collection_failed");
    }
  });

  app.post("/activity/actions", mutationLimit, async (c) => {
    try {
      if (!deps.executeAction) return unavailable(c);
      const body = ActionBodySchema.parse(await c.req.json());
      let releaseReservation: (() => void) | undefined;
      if (body.mode === "automatic") {
        releaseReservation = await reserveAutomaticCleanupBudget(deps, body.type, automaticBudget);
      }
      try {
        const result = await deps.executeAction(body);
        releaseReservation?.();
        return c.json(result);
      } catch (err) {
        releaseReservation?.();
        throw err;
      }
    } catch (err) {
      return safeError(c, err, "cleanup_failed");
    }
  });

  app.get("/activity/policy", async (c) => {
    try {
      if (!deps.readPolicy) return unavailable(c);
      return c.json(await deps.readPolicy());
    } catch (err) {
      return safeError(c, err, "policy_failed");
    }
  });

  app.put("/activity/policy", mutationLimit, async (c) => {
    try {
      if (!deps.savePolicy) return unavailable(c);
      const body = PolicyBodySchema.parse(await c.req.json());
      return c.json(await deps.savePolicy(body));
    } catch (err) {
      return safeError(c, err, "policy_failed");
    }
  });

  app.get("/activity/history", async (c) => {
    try {
      if (!deps.readHistory) return unavailable(c);
      const query = HistoryQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
      return c.json(await deps.readHistory(query));
    } catch (err) {
      return safeError(c, err, "history_failed");
    }
  });

  return app;
}

function unavailable(c: Context) {
  return c.json({ error: { code: "activity_unavailable", message: "Request failed" } }, 503);
}

function safeError(c: Context, err: unknown, fallbackCode: string) {
  if (err instanceof z.ZodError) {
    return c.json({ error: { code: "invalid_request", message: "Invalid request" } }, 400);
  }
  if (err instanceof ActivityConflictError) {
    console.warn("[system-activity] cleanup target changed:", err.message);
    return c.json({ error: { code: "candidate_conflict", message: "Cleanup target changed" } }, 409);
  }
  if (err instanceof ActivityForbiddenError) {
    console.warn("[system-activity] cleanup rejected:", err.message);
    return c.json({ error: { code: "cleanup_forbidden", message: "Cleanup is not allowed" } }, 403);
  }
  console.warn("[system-activity] route failed:", err instanceof Error ? err.message : String(err));
  return c.json({ error: { code: fallbackCode, message: "Request failed" } }, 500);
}

async function reserveAutomaticCleanupBudget(
  deps: SystemActivityRouteDeps,
  type: CleanupActionType,
  budget: { inFlight: number },
): Promise<() => void> {
  const policy = await deps.readPolicy?.();
  if (!policy?.enabled || !policy.allowedTypes.includes(type)) {
    throw new ActivityForbiddenError("automatic cleanup policy rejected action");
  }
  if (!deps.readHistory) throw new ActivityForbiddenError("automatic cleanup budget unavailable");
  const history = await deps.readHistory({ limit: 100 });
  const cutoffMs = Date.now() - 60 * 60 * 1000;
  const recentAutomaticActions = history.entries.filter((entry) => (
    entry.actor === "auto_policy" && Date.parse(entry.createdAt) >= cutoffMs
  )).length;
  if (recentAutomaticActions + budget.inFlight >= policy.maxActionsPerHour) {
    throw new ActivityForbiddenError("automatic cleanup rate limit reached");
  }
  budget.inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    budget.inFlight = Math.max(0, budget.inFlight - 1);
  };
}
