import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { AppAiRouteSelection } from "@matrix-os/contracts";
import { hostedBotsRouteIsManaged } from "../app-ai/runtime.js";
import type { HostedBotsModelProvider } from "./matrix-model.js";

export const MATRIX_BOTS_SCHEDULE_HEADER = "x-matrix-hosted-bots-schedule";
export const MATRIX_BOTS_SCHEDULE_LIMIT_MS = 31 * 24 * 60 * 60_000;
// Match the pinned RoutineManager's catch-up horizon. Claiming cannot move the due time.
export const MATRIX_BOTS_SCHEDULE_WINDOW_MS = 12 * 60 * 60_000;
export const MATRIX_BOTS_SCHEDULE_REFUSAL = "Choose one future time, an existing conversation on this bot, and a Matrix-managed model. Scheduled Matrix tasks support text only.";
const MAX_CREATE_BYTES = 32_000;
const ID = z.string().regex(/^[\w-]{1,128}$/u);
export const MATRIX_BOTS_ROUTINE_ID = z.uuid();
const pickId = z.string().regex(/^(?:@cf\/zai-org\/glm-5\.3-flash|matrix-route-[a-f0-9]{64})$/);
const modelSelection = z.strictObject({ instanceId: z.literal("matrix-hosted-ai"), model: pickId });
const claim = z.strictObject({
  routineId: MATRIX_BOTS_ROUTINE_ID,
  botId: ID,
  threadId: ID,
  modelId: pickId,
  scheduledFor: z.number().int().positive(),
});
const input = z.strictObject({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(4000),
  botId: ID,
  resultsThreadId: ID,
  schedule: z.strictObject({ type: z.literal("once"), at: claim.shape.scheduledFor }),
  modelSelection,
  target: z.literal("bot").optional(),
  groupId: z.null().optional(),
  runOn: z.literal("maus").optional(),
  enabled: z.literal(true).optional(),
  durationMinutes: z.number().int().min(5).max(240).optional(),
  timeoutMinutes: z.number().int().min(1).max(240).nullable().optional(),
  overlap: z.enum(["skip", "queue"]).optional(),
  continuity: z.literal(false).optional(),
  runOnStartup: z.literal(false).optional(),
  attachments: z.tuple([]).optional(),
});
export type HostedBotsScheduleClaim = z.infer<typeof claim>;
export type HostedBotsScheduleIntent = Omit<HostedBotsScheduleClaim, "routineId"> & { prompt: string };
export type HostedBotsScheduleGrantStore = {
  issue: (intent: HostedBotsScheduleIntent, now: number) => Promise<{ routineId: string; token: string } | null>;
  consume: (token: string, claim: HostedBotsScheduleClaim, now: number) => Promise<string | null>;
  revoke: (routineId: string) => Promise<void>;
};

export function readHostedBotsScheduleRequest(
  path: string, method: string, body: Uint8Array | undefined, contentType: string | undefined,
): HostedBotsScheduleIntent | null | undefined {
  if (path !== "/api/routines" || method !== "POST" || !body || body.byteLength > MAX_CREATE_BYTES
    || !/^application\/json(?:;|$)/i.test(contentType ?? "")) return undefined;
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(body)); }
  catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!(data && typeof data === "object" && "modelSelection" in data && data.modelSelection
    && typeof data.modelSelection === "object" && "instanceId" in data.modelSelection
    && data.modelSelection.instanceId === "matrix-hosted-ai")) return undefined;
  const parsed = input.safeParse(data);
  if (!parsed.success) return null;
  const row = parsed.data;
  return { botId: row.botId, threadId: row.resultsThreadId, modelId: row.modelSelection.model, scheduledFor: row.schedule.at, prompt: row.prompt };
}

export function createHostedBotsMatrixScheduleRoutes(options: {
  consume: HostedBotsScheduleGrantStore["consume"];
  resolve: (id: string) => Promise<AppAiRouteSelection | undefined>;
  generate: HostedBotsModelProvider["generate"];
  now?: () => number;
  lifecycle?: AbortSignal;
}) {
  const app = new Hono();
  app.post("/turn", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) return c.json({ error: "forbidden" }, 403);
    const payload = claim.safeParse(await c.req.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    }));
    if (!payload.success) return c.json({ error: "invalid_turn" }, 400);
    const now = options.now?.() ?? Date.now();
    if (payload.data.scheduledFor > now || now >= payload.data.scheduledFor + MATRIX_BOTS_SCHEDULE_WINDOW_MS
      || options.lifecycle?.aborted) return c.json({ error: "forbidden" }, 403);
    try {
      const prompt = await options.consume(token, payload.data, now);
      if (prompt === null) return c.json({ error: "forbidden" }, 403);
      const route = await options.resolve(payload.data.modelId);
      if (!route || !hostedBotsRouteIsManaged(route)) return c.json({ error: "unavailable" }, 503);
      const signal = AbortSignal.any([c.req.raw.signal, ...(options.lifecycle ? [options.lifecycle] : [])]);
      // The row holds the approved instructions. This path does not pass any
      // tools, transcript, attachments, or user/provider data from the workload.
      return c.json(await options.generate({ route, prompt, signal, requestClass: "background" }));
    } catch (error) {
      console.warn("[hosted-bots] Scheduled Matrix model unavailable", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "unavailable" }, 503);
    }
  });
  return app;
}
