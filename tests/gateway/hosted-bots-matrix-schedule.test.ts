import { expect, it, vi } from "vitest";
import {
  createHostedBotsMatrixScheduleRoutes, readHostedBotsScheduleRequest,
  type HostedBotsScheduleGrantStore,
} from "../../packages/gateway/src/hosted-bots/matrix-schedule.js";

const pick = "@cf/zai-org/glm-5.3-flash";
const route = { harnessId: "matrix_ai", accountId: null, accessSourceId: "matrix_cloudflare", modelId: pick } as const;
const at = 1_900_000_000_000;
const token = "b".repeat(64);
const routineId = "550e8400-e29b-41d4-a716-446655440000";
const scope = { botId: "pebble", threadId: "original", modelId: pick, scheduledFor: at };
const create = {
  name: "Daily check", prompt: "Return PEBBLE_SCHEDULE only.", botId: scope.botId, resultsThreadId: scope.threadId,
  schedule: { type: "once", at }, runOn: "maus", modelSelection: { instanceId: "matrix-hosted-ai", model: pick },
};
const request = (body: unknown, path = "/api/routines") => readHostedBotsScheduleRequest(path, "POST", new TextEncoder().encode(JSON.stringify(body)), "application/json");

it("only interprets a one-shot, text-only calendar save as an unattended Matrix grant", () => {
  expect(request(create)).toEqual({ ...scope, prompt: create.prompt });
  expect(request({ ...create, resultsThreadId: null })).toBeNull();
  expect(request({ ...create, resultsThreadId: true })).toBeNull();
  expect(request({ ...create, schedule: { type: "daily", at } })).toBeNull();
  expect(request({ ...create, checks: ["new-mail"] })).toBeNull();
  expect(request({ ...create, attachments: [{ path: "/vault/file" }] })).toBeNull();
  expect(request({ ...create, deliver: "brief" })).toBeNull();
  expect(request({ ...create, target: "room-goal" })).toBeNull();
  expect(request({ ...create, runOn: "cloud" })).toBeNull();
  expect(request({ ...create, modelSelection: { instanceId: "anthropic", model: "model" } })).toBeUndefined();
  expect(request(create, "/api/routines/elsewhere/run")).toBeUndefined();
});

it("redeems only the exact due one-shot text in the existing broker, without tools or replay", async () => {
  const consume = vi.fn<HostedBotsScheduleGrantStore["consume"]>()
    .mockResolvedValueOnce(create.prompt).mockResolvedValue(null);
  const generate = vi.fn(async () => ({ text: "PEBBLE_SCHEDULE" }));
  const resolve = vi.fn(async () => route);
  let now = at - 1;
  const app = createHostedBotsMatrixScheduleRoutes({ consume, resolve, generate, now: () => now });
  const run = (body: Record<string, unknown> = { ...scope, routineId }, bearer = token) => app.request("/turn", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: "Bearer " + bearer },
  });
  expect((await run()).status).toBe(403);
  now = at;
  expect((await run({ ...scope, routineId, prompt: "different" })).status).toBe(400);
  expect((await run({ ...scope, routineId, history: [{ role: "system", text: "different" }] })).status).toBe(400);
  expect((await run({ ...scope, routineId }, "forged")).status).toBe(403);
  expect(consume).not.toHaveBeenCalled();
  const results = await Promise.all([run(), run()]);
  expect(results.map(reply => reply.status).sort()).toEqual([200, 403]);
  expect(consume).toHaveBeenCalledWith(token, { ...scope, routineId }, now);
  expect(generate).toHaveBeenCalledOnce();
  expect(generate).toHaveBeenCalledWith({ route, prompt: create.prompt, signal: expect.any(AbortSignal), requestClass: "background" });
});

it("does not use a personal route for a scheduled turn even if advertised", async () => {
  const consume = vi.fn(async () => create.prompt);
  const generate = vi.fn(async () => ({ text: "PEBBLE_SCHEDULE" }));
  const app = createHostedBotsMatrixScheduleRoutes({
    consume, generate, now: () => at, resolve: async () => ({ ...route, accountId: "personal" }),
  });
  const reply = await app.request("/turn", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ ...scope, routineId }),
  });
  expect(reply.status).toBe(503);
  expect(generate).not.toHaveBeenCalled();
});
