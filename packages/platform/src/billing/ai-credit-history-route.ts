import type { Context, Handler } from "hono";
import { sql } from "kysely";
import { AiCreditHistoryQuerySchema, AiCreditHistoryResponseSchema } from "@matrix-os/contracts";
import { getActiveUserMachineByClerkId, type PlatformDB } from "../db.js";

// An opaque pagination marker, never an authentication credential. Every lookup
// independently applies the authenticated owner and current computer scope.
const marker = sql<string>`md5(l.entry_id || ':' || l.owner_id || ':' || l.machine_id || ':' || l.runtime_slot)`;

export function createAiCreditHistoryHandler(options: {
  db: PlatformDB;
  resolveClerkUserId: (c: Context) => Promise<string | null>;
}): Handler {
  return async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("CDN-Cache-Control", "no-store");
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
    c.header("Vary", "Authorization", { append: true });
    const ownerId = await options.resolveClerkUserId(c);
    if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
    const queries = c.req.queries();
    if (Object.values(queries).some((values) => values.length !== 1)) {
      return c.json({ error: "Invalid request" }, 400);
    }
    const parsed = AiCreditHistoryQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    try {
      const machine = await getActiveUserMachineByClerkId(options.db, ownerId, parsed.data.runtimeSlot);
      if (!machine || machine.status !== "running" || machine.activationState !== "authorized") {
        return c.json({ error: "Computer is unavailable", code: "runtime_unavailable" }, 409);
      }
      const scope = options.db.executor.selectFrom("ai_funded_credit_ledger as l")
        .where("l.owner_id", "=", ownerId).where("l.machine_id", "=", machine.machineId)
        .where("l.runtime_slot", "=", machine.runtimeSlot);
      const anchor = parsed.data.cursor ? await scope.select(["l.entry_id", "l.created_at"])
        .where(marker, "=", parsed.data.cursor).executeTakeFirst() : undefined;
      if (parsed.data.cursor && !anchor) return c.json({ error: "Invalid request" }, 400);
      let page = scope.leftJoin("ai_funded_usage_reservations as r", (join) => join
        .onRef("r.reservation_id", "=", "l.reservation_id")
        .onRef("r.owner_id", "=", "l.owner_id").onRef("r.machine_id", "=", "l.machine_id")
        .onRef("r.runtime_slot", "=", "l.runtime_slot").on("r.status", "=", "settled"))
        .select(["l.created_at", "l.kind", "l.amount_microusd", "r.model_id", "r.resolved_model", marker.as("cursor")]);
      // Both keys are NOT NULL. Row comparison preserves the DESC keyset
      // boundary and lets Postgres seek directly into the scoped ordering index.
      if (anchor) page = page.where(sql<boolean>`(l.created_at, l.entry_id) < (${anchor.created_at}, ${anchor.entry_id})`);
      const rows = await page.orderBy("l.created_at", "desc").orderBy("l.entry_id", "desc")
        .limit(parsed.data.limit + 1).execute();
      const visible = rows.slice(0, parsed.data.limit);
      const result = AiCreditHistoryResponseSchema.parse({
        entries: visible.map((row) => ({
          occurredAt: new Date(row.created_at).toISOString(),
          kind: ["promotional_debit", "addon_debit", "usage_shortfall"].includes(row.kind)
            ? "usage" : ["promotional_grant", "addon_grant"].includes(row.kind) ? "credit" : "adjustment",
          amountMicrousd: Number(row.amount_microusd),
          modelId: row.resolved_model ?? row.model_id ?? null,
        })),
        nextCursor: rows.length > parsed.data.limit ? visible.at(-1)?.cursor ?? null : null,
      });
      return c.json(result, 200);
    } catch (err: unknown) {
      console.error("[billing] AI credit history failed:", err instanceof Error ? err.name : typeof err);
      return c.json({ error: "History is unavailable" }, 503);
    }
  };
}
