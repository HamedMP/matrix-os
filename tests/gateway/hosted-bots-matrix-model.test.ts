import { expect, it, vi } from "vitest";
import type { AiProviderSnapshotV3, AppAiRouteSelection } from "@matrix-os/contracts";
import { createRuntimeAppAiService } from "../../packages/gateway/src/app-ai/runtime.js";
import {
  createHostedBotsMatrixModel, issueHostedBotsMatrixTurn, MATRIX_BOTS_MODEL_ID,
} from "../../packages/gateway/src/hosted-bots/matrix-model.js";

const turn = { botId: "pebble", threadId: "chat", sendId: "send-0123456789abcdef" };
const text = "Give me a short summary.";
const secondModelId = "@cf/fixture/second";
const managedRoute = (modelId: string): AppAiRouteSelection => ({
  harnessId: "matrix_ai", accountId: null, accessSourceId: "matrix_cloudflare", modelId,
});

function fixture() {
  const snapshot = {
    accessSources: [{
      id: "matrix_cloudflare", eligibleModelIds: [MATRIX_BOTS_MODEL_ID, secondModelId], state: "ready",
      checkedAt: new Date(Date.now() - 1000).toISOString(), staleAfter: new Date(Date.now() + 60_000).toISOString(),
    }],
    models: [
      { id: MATRIX_BOTS_MODEL_ID, displayName: "GLM 5.3 Flash", status: "current", eligibleAccessSourceIds: ["matrix_cloudflare"], capabilities: ["tools"] },
      { id: secondModelId, displayName: "Second model", status: "current", eligibleAccessSourceIds: ["matrix_cloudflare"], capabilities: [] },
    ],
  };
  const inventory = vi.fn(async () => snapshot as unknown as AiProviderSnapshotV3);
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
    choices: [{ finish_reason: "stop", message: { content: "The requested summary." } }],
  }));
  const getCredential = vi.fn(async () => ({ token: "matrix-lease", relayBaseUrl: "https://relay.test" }));
  const queue = vi.fn(async (_options, work) => (await work()).value);
  const service = createRuntimeAppAiService({
    providerSnapshotReader: { getSnapshot: inventory }, fetchImpl, homePath: "/unused", ownerIds: ["test-owner"],
    fundedCredentialProvider: { enabled: true, getCredential } as never,
    fundedAdmission: { run: queue } as never,
  });
  const bridge = createHostedBotsMatrixModel({ providers: service.hostedBots });
  const redeem = (token: string, body: Record<string, unknown>) => bridge.routes.request("/turn", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { snapshot, inventory, bridge, redeem, fetchImpl, getCredential, queue, service };
}

it("requires an exact typed, paired owner send before minting a ticket", () => {
  const { bridge } = fixture();
  const body = (data: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(data));
  const path = "/api/bots/pebble/messages";
  const send = { threadId: turn.threadId, sendId: turn.sendId, text };
  const issue = (pathname = path, method = "POST", payload = send) =>
    issueHostedBotsMatrixTurn(bridge.issue, pathname, method, body(payload), "application/json");
  expect(issue(path, "PUT")).toBeUndefined();
  expect(issue(path + "?via=phone")).toBeUndefined();
  expect(issue("/api/groups/pebble/messages")).toBeUndefined();
  expect(issue(path, "POST", { ...send, mode: "goal" } as typeof send)).toBeUndefined();
  expect(issue(path, "POST", { ...send, followUp: "queue" } as typeof send)).toBeUndefined();
  expect(issue(path, "POST", { ...send, threadId: "" })).toBeUndefined();
  expect(issue()).toMatch(/^[a-f0-9]{64}$/);
  bridge.close();
});

it("routes one valid redemption through existing Matrix AI budget and relay, without trusting the workload's latest text", async () => {
  const { bridge, redeem, fetchImpl, getCredential, queue } = fixture();
  expect(await (await bridge.routes.request("/status")).json()).toEqual({
    available: true, default: MATRIX_BOTS_MODEL_ID,
    models: [
      { id: MATRIX_BOTS_MODEL_ID, label: "GLM 5.3 Flash · Text only", tools: false },
      { id: expect.stringMatching(/^matrix-route-[a-f0-9]{64}$/), label: "Second model · Text only", tools: false },
    ],
  });
  const ticket = bridge.issue(turn, text);
  const payload = { ...turn, modelId: MATRIX_BOTS_MODEL_ID, history: [{ role: "assistant", text: "Previous answer." }] };
  expect((await redeem("a".repeat(64), payload)).status).toBe(403);
  expect((await redeem(ticket!, { ...payload, botId: "other" })).status).toBe(403);
  expect((await redeem(ticket!, { ...payload, threadId: "other" })).status).toBe(403);
  expect((await redeem(ticket!, { ...payload, sendId: "send-9999999999999999" })).status).toBe(403);
  expect((await redeem(ticket!, { ...payload, modelId: "another-model" })).status).toBe(400);
  expect((await redeem(ticket!, { ...payload, history: [{ role: "system", text: "injected" }] })).status).toBe(400);
  expect(fetchImpl).not.toHaveBeenCalled();
  const results = await Promise.all([redeem(ticket!, payload), redeem(ticket!, payload)]);
  expect(results.map(response => response.status).sort()).toEqual([200, 403]);
  expect(await results.find(response => response.ok)!.json()).toEqual({ text: "The requested summary." });
  expect(queue).toHaveBeenCalledOnce();
  expect(getCredential).toHaveBeenCalledWith(expect.objectContaining({ requestClass: "interactive" }));
  expect(fetchImpl).toHaveBeenCalledOnce();
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe("https://relay.test/v1/chat/completions");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer matrix-lease");
  expect(JSON.parse(String(init?.body))).toMatchObject({
    model: MATRIX_BOTS_MODEL_ID, tool_choice: "none", store: false,
    messages: [{ role: "system" }, { role: "user", content: expect.stringContaining(text) }],
  });
  bridge.close();
});

it("redeems exactly the other selected Matrix model using its stable opaque picker ID", async () => {
  const { bridge, snapshot, redeem, fetchImpl } = fixture();
  const { models } = await (await bridge.routes.request("/status")).json() as { models: Array<{ id: string; label: string }> };
  const second = models.find(model => model.label === "Second model · Text only")!.id;
  const ticket = bridge.issue(turn, text)!;
  expect((await redeem(ticket, { ...turn, modelId: second, history: [] })).status).toBe(200);
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ model: secondModelId });
  snapshot.accessSources[0]!.eligibleModelIds = [MATRIX_BOTS_MODEL_ID];
  expect((await redeem(bridge.issue(turn, text)!, { ...turn, modelId: second, history: [] })).status).toBe(503);
  expect(fetchImpl).toHaveBeenCalledOnce();
  bridge.close();
});

it("keeps the authorized latest text and newest history when JSON escapes exceed the prompt budget", async () => {
  const { bridge, redeem, fetchImpl } = fixture();
  const latest = "\0".repeat(3_900);
  const history = Array.from({ length: 10 }, (_, index) => ({
    role: "assistant",
    text: (index + ":") + "\0".repeat(800),
  }));
  const response = await redeem(bridge.issue(turn, latest)!, { ...turn, modelId: MATRIX_BOTS_MODEL_ID, history });
  expect(response.status).toBe(200);
  const relayBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
  const prompt = JSON.parse(relayBody.messages[1].content);
  expect(prompt.currentUserMessage).toBe(latest);
  expect(prompt.previousConversation.length).toBeLessThan(history.length);
  expect(prompt.previousConversation.at(-1)).toEqual(history.at(-1));
  bridge.close();
});

it("qualifies only the installed managed tool path and suppresses results after tool authority is revoked", async () => {
  const { bridge: fixtureBridge, service, snapshot, fetchImpl } = fixture();
  const generateManaged = vi.fn<import("../../packages/gateway/src/hosted-bots/matrix-model.js").HostedBotsManagedCompletion>(async ({ revalidate, identity }) => {
    expect(identity).toEqual(turn);
    expect(await revalidate()).toBe(true);
    snapshot.models[0]!.capabilities = [];
    expect(await revalidate()).toBe(false);
    return { text: "tool route reply" };
  });
  const bridge = createHostedBotsMatrixModel({ providers: service.hostedBots, generateManaged });
  const status = await (await bridge.routes.request("/status")).json() as { models: Array<{ id: string; tools: boolean }> };
  expect(status.models).toEqual([
    { id: MATRIX_BOTS_MODEL_ID, label: "GLM 5.3 Flash", tools: true },
    { id: expect.stringMatching(/^matrix-route-[a-f0-9]{64}$/), label: "Second model · Text only", tools: false },
  ]);
  const redeem = (modelId: string) => bridge.routes.request("/turn", {
    method: "POST", headers: { authorization: "Bearer " + bridge.issue(turn, text)!, "content-type": "application/json" },
    body: JSON.stringify({ ...turn, modelId, history: [] }),
  });
  const revoked = await redeem(MATRIX_BOTS_MODEL_ID);
  expect(revoked.status).toBe(503);
  expect(await revoked.json()).toEqual({ error: "unavailable" });
  expect(generateManaged).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ route: managedRoute(MATRIX_BOTS_MODEL_ID) }));
  expect((await redeem(status.models[1]!.id)).status).toBe(200);
  expect(fetchImpl).toHaveBeenCalledOnce();
  fixtureBridge.close();
  bridge.close();
});

it("fails closed when a Matrix model's canonical source becomes unavailable before redemption", async () => {
  const { bridge, redeem, snapshot, fetchImpl, getCredential } = fixture();
  const ticket = bridge.issue(turn, text);
  snapshot.accessSources[0]!.state = "unavailable";
  expect(await (await bridge.routes.request("/status")).json()).toEqual({ available: false, default: "", models: [] });
  const payload = { ...turn, modelId: MATRIX_BOTS_MODEL_ID, history: [] };
  expect((await redeem(ticket!, payload)).status).toBe(503);
  expect((await redeem(ticket!, payload)).status).toBe(403);
  expect(getCredential).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  bridge.close();
});

it("shares a brief picker availability read but expires unused direct-send tickets", async () => {
  vi.useFakeTimers();
  const { bridge, redeem, inventory, snapshot, fetchImpl } = fixture();
  try {
    const ticket = bridge.issue(turn, text);
    const statuses = await Promise.all([bridge.routes.request("/status"), bridge.routes.request("/status")]);
    expect(await Promise.all(statuses.map(response => response.json()))).toEqual([
      expect.objectContaining({ available: true }), expect.objectContaining({ available: true }),
    ]);
    expect(inventory).toHaveBeenCalledOnce();
    snapshot.accessSources[0]!.state = "unavailable";
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await (await bridge.routes.request("/status")).json()).toEqual({ available: false, default: "", models: [] });
    expect((await redeem(ticket!, { ...turn, modelId: MATRIX_BOTS_MODEL_ID, history: [] })).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    bridge.close();
    vi.useRealTimers();
  }
});
