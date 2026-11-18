import { expect, it, vi } from "vitest";
import type { AiProviderSnapshotV3, AppAiRouteSelection } from "@matrix-os/contracts";
import { createRuntimeAppAiService, type HostedBotsAppAiCatalog } from "../../packages/gateway/src/app-ai/runtime.js";
import type { ProviderSnapshotReadOptions } from "../../packages/gateway/src/ai-providers/snapshot-read-options.js";
import {
  createHostedBotsMatrixModel, issueHostedBotsMatrixTurn, MATRIX_BOTS_MODEL_ID,
} from "../../packages/gateway/src/hosted-bots/matrix-model.js";

const turn = { botId: "pebble", threadId: "chat", sendId: "send-0123456789abcdef" };
const text = "Give me a short summary.";
const secondModelId = "@cf/fixture/second";
const managedRoute = (modelId: string): AppAiRouteSelection => ({
  harnessId: "matrix_ai", accountId: null, accessSourceId: "matrix_cloudflare", modelId,
});
const pickerManaged: HostedBotsAppAiCatalog["routes"][number] = {
  ...managedRoute(MATRIX_BOTS_MODEL_ID), displayName: "Matrix AI", availability: "available",
  readiness: "ready", reason: null, modelLabel: "Managed model", supportsManagedTools: true,
};
const pickerPersonal: HostedBotsAppAiCatalog["routes"][number] = {
  harnessId: "native-claude", accountId: "owner-claude", accessSourceId: "owner_claude_profile",
  modelId: "claude-sonnet-5", displayName: "Claude", availability: "available", readiness: "local_profile",
  reason: null, modelLabel: "Connected model", supportsManagedTools: false,
};
const pickerCatalog = (...routes: HostedBotsAppAiCatalog["routes"]): HostedBotsAppAiCatalog => ({ routes, defaultRoute: null });

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
  const inventory = vi.fn(async (_options?: ProviderSnapshotReadOptions) => snapshot as unknown as AiProviderSnapshotV3);
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
    expect(inventory.mock.calls.filter(([options]) => options?.admissionScope === "managed_matrix")).toHaveLength(1);
    expect(inventory.mock.calls.filter(([options]) => !options?.admissionScope)).toHaveLength(1);
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

it("returns the managed catalog while a single slow native read continues in the background", async () => {
  let finishNative!: (catalog: HostedBotsAppAiCatalog) => void;
  const native = new Promise<HostedBotsAppAiCatalog>(resolve => { finishNative = resolve; });
  const discover = vi.fn((_signal: AbortSignal, scope?: "managed" | "all") =>
    scope === "managed" ? Promise.resolve(pickerCatalog(pickerManaged)) : native);
  const bridge = createHostedBotsMatrixModel({ providers: { discover, generate: vi.fn() } });
  try {
    const statuses = await Promise.all([bridge.routes.request("/status"), bridge.routes.request("/status")]);
    const results = await Promise.all(statuses.map(response => response.json()));
    expect(results).toEqual([
      expect.objectContaining({ available: true, refreshing: true, models: [expect.objectContaining({ label: "Managed model · Text only" })] }),
      expect.objectContaining({ available: true, refreshing: true, models: [expect.objectContaining({ label: "Managed model · Text only" })] }),
    ]);
    expect(discover.mock.calls.map(([, scope]) => scope).sort()).toEqual(["all", "managed"]);
    const completion = bridge.routes.request("/status?complete=1");
    finishNative(pickerCatalog(pickerManaged, pickerPersonal));
    expect(await (await completion).json()).toMatchObject({
      models: [expect.objectContaining({ label: "Managed model · Text only" }), expect.objectContaining({ label: "Connected model · Claude · Text only" })],
    });
    await vi.waitFor(async () => {
      expect(await (await bridge.routes.request("/status")).json()).toMatchObject({
        available: true, models: [expect.objectContaining({ label: "Managed model · Text only" }), expect.objectContaining({ label: "Connected model · Claude · Text only" })],
      });
    });
  } finally {
    finishNative(pickerCatalog());
    bridge.close();
  }
});

it("holds transient native picker observations only until expiry and discards a successful revocation", async () => {
  vi.useFakeTimers();
  let full: HostedBotsAppAiCatalog | Error = pickerCatalog(pickerManaged, pickerPersonal);
  const discover = vi.fn(async (_signal: AbortSignal, scope?: "managed" | "all") => {
    if (scope === "managed") return pickerCatalog(pickerManaged);
    if (full instanceof Error) throw full;
    return full;
  });
  const bridge = createHostedBotsMatrixModel({ providers: { discover, generate: vi.fn() } });
  const status = async () => await (await bridge.routes.request("/status")).json() as { models: Array<{ label: string }> };
  try {
    expect((await status()).models).toHaveLength(2);
    full = new DOMException("Synthetic slow native status", "TimeoutError");
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await status()).models).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await status()).models).toHaveLength(1);
    full = pickerCatalog(pickerManaged, pickerPersonal);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await status()).models).toHaveLength(2);
    full = pickerCatalog(pickerManaged);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await status()).models).toHaveLength(1);
  } finally {
    bridge.close();
    vi.useRealTimers();
  }
});

it("uses a successful full catalog after fast discovery fails without restoring rows revoked by the fast catalog", async () => {
  vi.useFakeTimers();
  const timeout = new DOMException("Synthetic catalog deadline", "TimeoutError");
  let managed: HostedBotsAppAiCatalog | Error = timeout;
  let full: HostedBotsAppAiCatalog | Error = pickerCatalog(pickerManaged);
  const discover = vi.fn(async (_signal: AbortSignal, scope?: "managed" | "all") => {
    const result = scope === "managed" ? managed : full;
    if (result instanceof Error) throw result;
    return result;
  });
  const bridge = createHostedBotsMatrixModel({ providers: { discover, generate: vi.fn() } });
  const status = async () => await (await bridge.routes.request("/status")).json();
  const empty = { available: false, default: "", models: [] };
  try {
    expect(await status()).toMatchObject({
      available: true, default: MATRIX_BOTS_MODEL_ID,
      models: [expect.objectContaining({ id: MATRIX_BOTS_MODEL_ID })],
    });
    await vi.advanceTimersByTimeAsync(4_000);
    managed = pickerCatalog();
    expect(await status()).toEqual(empty);
    await vi.advanceTimersByTimeAsync(13_000);
    managed = timeout;
    full = timeout;
    expect(await status()).toEqual(empty);
  } finally {
    bridge.close();
    vi.useRealTimers();
  }
});
