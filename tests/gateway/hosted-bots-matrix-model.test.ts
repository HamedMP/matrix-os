import { expect, it, vi } from "vitest";
import type { AiProviderSnapshotV3 } from "@matrix-os/contracts";
import {
  createHostedBotsMatrixModel, issueHostedBotsMatrixTurn, MATRIX_BOTS_MODEL_ID,
} from "../../packages/gateway/src/hosted-bots/matrix-model.js";

const turn = { botId: "pebble", threadId: "chat", sendId: "send-0123456789abcdef" };
const text = "Give me a short summary.";

function fixture() {
  const snapshot = {
    accessSources: [{
      id: "matrix_cloudflare", eligibleModelIds: [MATRIX_BOTS_MODEL_ID], state: "ready",
      checkedAt: new Date(Date.now() - 1000).toISOString(), staleAfter: new Date(Date.now() + 60_000).toISOString(),
    }],
    models: [{ id: MATRIX_BOTS_MODEL_ID, status: "available", eligibleAccessSourceIds: ["matrix_cloudflare"] }],
  };
  const inventory = vi.fn(async () => snapshot as unknown as AiProviderSnapshotV3);
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
    choices: [{ finish_reason: "stop", message: { content: "The requested summary." } }],
  }));
  const getCredential = vi.fn(async () => ({ token: "matrix-lease", relayBaseUrl: "https://relay.test" }));
  const queue = vi.fn(async (_options, work) => (await work()).value);
  const bridge = createHostedBotsMatrixModel({
    inventory, fetchImpl, homePath: "/unused",
    fundedCredentialProvider: { enabled: true, getCredential } as never,
    fundedAdmission: { run: queue } as never,
  });
  const redeem = (token: string, body: Record<string, unknown>) => bridge.routes.request("/turn", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { snapshot, inventory, bridge, redeem, fetchImpl, getCredential, queue };
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
  expect(await (await bridge.routes.request("/status")).json()).toEqual({ available: true });
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

it("fails closed when a Matrix model's canonical source becomes unavailable before redemption", async () => {
  const { bridge, redeem, snapshot, fetchImpl, getCredential } = fixture();
  const ticket = bridge.issue(turn, text);
  snapshot.accessSources[0]!.state = "unavailable";
  expect(await (await bridge.routes.request("/status")).json()).toEqual({ available: false });
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
    expect(await Promise.all(statuses.map(response => response.json()))).toEqual([{ available: true }, { available: true }]);
    expect(inventory).toHaveBeenCalledOnce();
    snapshot.accessSources[0]!.state = "unavailable";
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await (await bridge.routes.request("/status")).json()).toEqual({ available: false });
    expect((await redeem(ticket!, { ...turn, modelId: MATRIX_BOTS_MODEL_ID, history: [] })).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    bridge.close();
    vi.useRealTimers();
  }
});
