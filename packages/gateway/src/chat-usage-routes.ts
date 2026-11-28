import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { RequestPrincipal } from "./request-principal.js";
import type { createChatAnalyticsStore, createTransientChatClassifier } from "./chat-analytics/index.js";

const DISCLOSURE = "chat-usage-v1";
const Policy = z.strictObject({ enabled: z.boolean(), sampleRateBps: z.number().int().min(0).max(10_000),
  disclosureVersion: z.literal(DISCLOSURE).optional(),
}).refine(value => !value.enabled || value.disclosureVersion === DISCLOSURE);
const Group = z.enum(["taskFamily", "taskType", "complexity", "modelId", "harness", "accessSource"]);
const Query = z.strictObject({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  groupBy: z.string().max(160).optional(), limit: z.coerce.number().int().min(1).max(200).default(100),
});
export interface ChatUsageRuntime {
  store: ReturnType<typeof createChatAnalyticsStore>;
  classifier: ReturnType<typeof createTransientChatClassifier>;
  modelId: string;
}

/** Mount only behind the gateway's normal authenticated request middleware. */
export function createChatUsageRoutes(options: {
  ownerId: string | null;
  getPrincipal(c: Context): RequestPrincipal | null;
  getRuntime(): ChatUsageRuntime | undefined;
  now?: () => Date;
}): Hono {
  const app = new Hono();
  app.use("/api/chat-usage/*", async (c, next) => {
    try {
      const principal = options.getPrincipal(c);
      if (!principal) return c.json({ error: "Unauthorized" }, 401);
      if (!options.ownerId || principal.userId !== options.ownerId
        || !["jwt", "platform-verified"].includes(principal.source)) return c.json({ error: "Forbidden" }, 403);
      if (!options.getRuntime()) return c.json({ error: "Chat usage unavailable" }, 503);
      c.header("cache-control", "no-store");
      await next();
    } catch (error: unknown) {
      console.warn("[chat-usage] request unavailable", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Chat usage unavailable" }, 503);
    }
  });
  const summary = (enabled: boolean, sampleRateBps: number, modelId: string) => ({ enabled, sampleRateBps, modelId,
    recipient: "Cloudflare Workers AI", disclosureVersion: DISCLOSURE, retentionDays: 30 });
  app.get("/api/chat-usage/policy", async c => {
    const runtime = options.getRuntime()!;
    const policy = await runtime.store.getOwnerPolicy(options.ownerId!);
    return c.json(summary(policy?.enabled ?? false, policy?.sampleRateBps ?? 1000, runtime.modelId));
  });
  const mutationLimit = bodyLimit({ maxSize: 4096, onError: c => c.json({ error: "Request too large" }, 413) });
  app.put("/api/chat-usage/policy", mutationLimit, async c => {
    let value: unknown;
    try { value = await c.req.json(); }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) console.warn("[chat-usage] invalid body", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Invalid request" }, 400);
    }
    const parsed = Policy.safeParse(value);
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const runtime = options.getRuntime()!;
    const { enabled, sampleRateBps } = parsed.data;
    await runtime.store.configureOwner(options.ownerId!, { enabled, sampleRateBps });
    // Rotate the durable admission epoch before cancelling in-memory work.
    if (!enabled) await runtime.classifier.cancelOwner(options.ownerId!);
    return c.json(summary(enabled, sampleRateBps, runtime.modelId));
  });
  app.get("/api/chat-usage/summary", async c => {
    const raw = new URL(c.req.url).searchParams;
    if ([...raw.keys()].some(key => raw.getAll(key).length !== 1)) return c.json({ error: "Invalid query" }, 400);
    const parsed = Query.safeParse(Object.fromEntries(raw));
    if (!parsed.success) return c.json({ error: "Invalid query" }, 400);
    const now = options.now?.() ?? new Date();
    const to = parsed.data.to ?? now.toISOString();
    const from = parsed.data.from ?? new Date(Date.parse(to) - 7 * 86_400_000).toISOString();
    const groups = z.array(Group).min(1).max(4).safeParse((parsed.data.groupBy ?? "taskFamily").split(","));
    const duration = Date.parse(to) - Date.parse(from);
    if (!groups.success || new Set(groups.data).size !== groups.data.length || !Number.isFinite(duration)
      || duration <= 0 || duration > 31 * 86_400_000 || Date.parse(to) > now.getTime() + 60_000) return c.json({ error: "Invalid query" }, 400);
    const buckets = await options.getRuntime()!.store.aggregate({ ownerId: options.ownerId!, from, to,
      groupBy: groups.data, includeUnclassified: true, limit: parsed.data.limit });
    return c.json({ from, to, buckets, groupLimit: parsed.data.limit,
      mayBeTruncated: buckets.length === parsed.data.limit, classificationIsEstimate: true });
  });
  app.delete("/api/chat-usage/data", mutationLimit, async c => {
    const text = await c.req.text();
    if (text.trim() && text.trim() !== "{}") return c.json({ error: "Invalid request" }, 400);
    await options.getRuntime()!.classifier.deleteOwner(options.ownerId!);
    return c.json({ deleted: true, enabled: false });
  });
  app.onError((error, c) => {
    console.warn("[chat-usage] operation unavailable", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "Chat usage unavailable" }, 503);
  });
  return app;
}
