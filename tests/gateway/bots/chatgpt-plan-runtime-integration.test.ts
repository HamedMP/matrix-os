import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import { chatGptPlanPeerProof, type ChatGptPlanPeerRequest } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { BROKER_PLACEHOLDER_KEY, createBridgeModel } from "../../../packages/bot-runtime/src/providers.js";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import { createChatGptPlanPeers } from "../../../packages/gateway/src/bots/chatgpt-plan-peers.js";
import { BotRuntimeRegistry, type BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotStateDatabase } from "./bot-state-support.js";

const modelId = "gpt-account-model";
const frame = (type: string, fields: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
function response(item: Record<string, unknown>): string {
  return frame("response.created", { response: { id: "resp_test" } })
    + frame("response.output_item.added", { output_index: 0, item })
    + frame("response.output_item.done", { output_index: 0, item })
    + frame("response.completed", { response: { id: "resp_test", model: modelId, status: "completed", output: [item] } });
}

describe("pinned Pi SDK through owner-device subscription broker (synthetic provider)", () => {
  it("completes a tool round trip through signed enrollment without native credentials or Matrix funding", async () => {
    const db = await createBotStateDatabase();
    const peers = createChatGptPlanPeers({ db: db.db, ownerId: "owner", computerId: "main" });
    const registry = new BotRuntimeRegistry();
    try {
      const keys = generateKeyPairSync("ed25519");
      const publicKey = keys.publicKey.export({ type: "spki", format: "der" });
      const snapshot = {
        deviceId: createHash("sha256").update(publicKey).digest("hex"),
        accountId: "account_own", grantRevision: 3, enabled: true, background: false,
        models: [{ id: modelId, displayName: "Account model", input: ["text" as const], contextWindow: 128000, maxOutputTokens: 8192 }],
      };
      const challenge = peers.challenge("owner");
      const session = await peers.connect("owner", {
        version: 1, challenge: challenge.challenge, publicKey: publicKey.toString("base64url"), snapshot,
        signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString("base64url"),
      });
      const resolved = await peers.resolve({ instanceId: "matrix_chatgpt_plan", model: modelId,
        options: [{ id: "accountId", value: snapshot.accountId }, { id: "grantRevision", value: "3" }] }, "owner", "interactive");
      const binding: BotRuntimeBinding = {
        ...resolved, runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", ownerId: "owner",
        botId: "bot_12345678", chatId: "chat_test", taskId: "task_test", runId: "run_test",
        rootFingerprint: "a".repeat(64), capabilities: [], requestClass: "interactive",
      };
      registry.bind(binding);
      const resolveCredentials = vi.fn();
      const fundedAdmission = { execute: vi.fn() };
      const externalFetch = vi.fn();
      const wires: Array<Extract<ChatGptPlanPeerRequest, { action: "infer" }>> = [];
      const replies = [
        response({ type: "function_call", id: "fc_read", call_id: "call_read", name: "artifact_read", arguments: "{}", status: "completed" }),
        response({ type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Read confirmed: OWN_TOOL_RESULT", annotations: [] }] }),
      ];
      const fetchImpl: typeof fetch = async (_url, init) => {
        const pending = forwardBotInference({ version: 1, action: "inference.responses", requestId: randomUUID(),
          runtimeHandle: binding.runtimeHandle, executionGeneration: "1", path: "/v1/responses", headers: {}, body: String(init?.body) },
        binding, selected => registry.authorize({ ...binding, action: "inference.responses", modelId: selected }), {
          homePath: "/owner", lifetime: new AbortController().signal, runSignal: registry.inferenceSignal(binding)!,
          chatgptPlan: peers, resolveCredentials, fundedAdmission, fetchImpl: externalFetch,
        } as never);
        const polled = await peers.poll("owner", session);
        const request = polled.requests.find(value => value.action === "infer");
        expect(request?.action).toBe("infer");
        if (!request || request.action !== "infer") throw new Error("missing inference request");
        wires.push(request);
        peers.reply("owner", { ...session, id: request.id, ok: true, status: 200,
          headers: { "content-type": "text/event-stream" }, body: replies.shift()! });
        const delivered = await pending;
        if (!delivered.ok) throw new Error(`broker refused: ${delivered.error}`);
        return new Response(delivered.body, { status: delivered.status, headers: delivered.headers });
      };
      const bridge = createBridgeModel(resolved.route, "http://127.0.0.1:41000");
      const tools = [{ name: "artifact_read", description: "Read an artifact", parameters: { type: "object", properties: {} } }];
      const messages: Message[] = [{ role: "user", content: "Read the artifact", timestamp: Date.now() }];
      const options = { apiKey: BROKER_PLACEHOLDER_KEY, fetch: fetchImpl, maxRetries: 0, maxTokens: 8192 };
      const first = await bridge.provider.streamSimple(bridge.model, normalizeContext({ systemPrompt: "Be careful", messages, tools }), options).result();
      expect(first.stopReason).toBe("toolUse");
      const call = first.content.find(value => value.type === "toolCall");
      expect(call).toMatchObject({ name: "artifact_read", arguments: {} });
      if (!call || call.type !== "toolCall") throw new Error("missing tool call");
      messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: [{ type: "text", text: "OWN_TOOL_RESULT" }], isError: false, timestamp: Date.now() });
      const second = await bridge.provider.streamSimple(bridge.model, normalizeContext({ systemPrompt: "Be careful", messages, tools }), options).result();
      expect(second.stopReason).toBe("stop");
      expect(second.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "Read confirmed: OWN_TOOL_RESULT" })]));
      expect(wires).toHaveLength(2);
      const continuation = JSON.parse(wires[1]!.body);
      expect(continuation.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "additional_tools", role: "developer" }),
        expect.objectContaining({ role: "developer" }),
        expect.objectContaining({ type: "function_call", name: "artifact_read" }),
        expect.objectContaining({ type: "function_call_output", output: "OWN_TOOL_RESULT" }),
      ]));
      expect(continuation).not.toHaveProperty("max_output_tokens");
      expect(continuation).not.toHaveProperty("previous_response_id");
      expect(resolveCredentials).not.toHaveBeenCalled();
      expect(fundedAdmission.execute).not.toHaveBeenCalled();
      expect(externalFetch).not.toHaveBeenCalled();
      peers.disconnect("owner", session);
      expect(await peers.revalidate(binding, new AbortController().signal)).toBe(false);
    } finally {
      peers.close();
      registry.release(`runtime_${"a".repeat(32)}`);
      await db.destroy();
    }
  });
});

it("transports four 2MiB images from the installed Pi worker over Unix/EOF broker through a signed native subscription peer", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises"); const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { startInferenceBridge, inferenceActionForPath } = await import("../../../packages/scope-runtime/src/inference-bridge.js");
  const { createScopeRuntimeBrokerServer } = await import("../../../packages/gateway/src/collaboration/scope-runtime-broker.js");
  const { ScopeRuntimeBotInferenceRequestSchema } = await import("../../../packages/scope-runtime/src/broker-protocol.js");
  const { createPlanNativePeer } = await import("../../../desktop/src/main/chatgpt-plan/peer.js");
  const { requestPlanResponse, requestPlanResponseStream } = await import("../../../desktop/src/main/chatgpt-plan/responses.js");
  const { runBotTurn } = await import("../../../packages/bot-runtime/src/loop.js");
  const { insertChat } = await import("./bot-state-support.js");
  const { createBotSessionsRepository } = await import("../../../packages/gateway/src/bots/repositories/sessions.js");
  const { BotSessionSaveRequestSchema, BotBrokerRequestSchema, BOT_SESSION_MAX_BYTES } = await import("@matrix-os/contracts");
  const state = await createBotStateDatabase(); await insertChat(state.db, "chat_test", "owner"); const sessions = createBotSessionsRepository(state.db);
  const key = { ownerId: "owner", botId: "bot_12345678", chatId: "chat_test" };
  const dir = await mkdtemp(join(tmpdir(), "pi-images-"));
  const peers = createChatGptPlanPeers({ db: state.db, ownerId: "owner", computerId: "main" }); const registry = new BotRuntimeRegistry();
  const keys = generateKeyPairSync("ed25519"); const publicKey = keys.publicKey.export({ type: "spki", format: "der" });
  const snapshot = { deviceId: createHash("sha256").update(publicKey).digest("hex"), accountId: "account_own", grantRevision: 3, enabled: true, background: false,
    models: [{ id: modelId, displayName: "Account vision model", input: ["text", "image"] as ("text" | "image")[], contextWindow: 128000, maxOutputTokens: 8192 }] };
  const image = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(2 * 1024 * 1024 - 8, 7)]).toString("base64");
  let nativeCalls = 0; let current = true; let frames = 0;
  const inferInput = (request: Extract<ChatGptPlanPeerRequest, { action: "infer" }>, signal: AbortSignal) => ({
    model: modelId, body: request.body, signal,
    accessToken: async () => "synthetic-subscription-token", validate: () => { expect(current).toBe(true); },
    fetchFn: async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); const user = [...body.input].reverse().find((item: { role?: string }) => item.role === "user");
      expect((Array.isArray(user.content) ? user.content : []).filter((part: { type: string }) => part.type === "input_image")).toEqual(nativeCalls === 0 ? Array.from({ length: 4 }, () => expect.objectContaining({ image_url: `data:image/png;base64,${image}` })) : []);
      nativeCalls++;
      return new Response(response({ type: "message", id: "msg_image", role: "assistant", status: "completed", content: [{ type: "output_text", text: "PIXELS_TRANSFERRED", annotations: [] }] }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const native = createPlanNativePeer({ connected: () => undefined, current: () => current,
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname.split("/").at(-1); const body = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-runtime");
      if (path === "challenge") return Response.json(peers.challenge("owner"));
      if (path === "connect") return Response.json(await peers.connect("owner", body));
      if (path === "poll") return Response.json(await peers.poll("owner", body));
      if (path === "reply") return Response.json(await peers.reply("owner", body));
      if (path === "disconnect") { peers.disconnect("owner", body); return Response.json({ ok: true }); }
      throw new Error("Unknown peer route");
    }, infer: (request, signal) => requestPlanResponse(inferInput(request, signal)),
    inferStream: (request, signal) => requestPlanResponseStream(inferInput(request, signal)),
  });
  let server: ReturnType<typeof createScopeRuntimeBrokerServer> | undefined;
  let bridge: Awaited<ReturnType<typeof startInferenceBridge>> | undefined;
  try {
    await native.start({ runtimeSlot: "primary", authGeneration: 1, ownerId: "owner", computerId: "main", origin: "https://matrix.test", bearer: "synthetic-runtime",
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: publicKey.toString("base64url") }, snapshot);
    const resolved = await peers.resolve({ instanceId: "matrix_chatgpt_plan", model: modelId, options: [{ id: "accountId", value: snapshot.accountId }, { id: "grantRevision", value: "3" }] }, "owner", "interactive");
    let binding: BotRuntimeBinding = { ...resolved, runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", ownerId: "owner", botId: "bot_12345678", chatId: "chat_test", taskId: "task_test", runId: "run_images", rootFingerprint: "a".repeat(64), capabilities: [], requestClass: "interactive" };
    registry.bind(binding);
    const noFunding = vi.fn();
    server = createScopeRuntimeBrokerServer({ socketPath: join(dir, "broker.sock"), botImageFrames: true,
      broker: { handle: async () => { throw new Error("Shared broker must not accept Bot images"); }, close: () => undefined }, routeFrame: async raw => {
        const frame = ScopeRuntimeBotInferenceRequestSchema.parse(raw); frames++;
        if (frames === 1) expect(Buffer.byteLength(frame.body)).toBeGreaterThan(8 * 1024 * 1024);
        else expect(Buffer.byteLength(frame.body)).toBeLessThan(256 * 1024);
        expect(registry.lookup(frame)).toMatchObject({ runId: binding.runId, executionGeneration: binding.executionGeneration });
        return forwardBotInference(frame, binding, selected => registry.authorize({ ...binding, action: frame.action, modelId: selected }),
          { homePath: "/owner", lifetime: new AbortController().signal, runSignal: registry.inferenceSignal(binding)!, chatgptPlan: peers, resolveCredentials: noFunding, fundedAdmission: { execute: noFunding }, fetchImpl: noFunding } as never);
      } });
    await server.start();
    bridge = await startInferenceBridge({ brokerSocket: join(dir, "broker.sock"), socketPath: join(dir, "inference.sock"), botImages: true,
      runtimeHandle: binding.runtimeHandle, executionGeneration: "1", actionFor: request => inferenceActionForPath(request.url) });
    const outcome = await runBotTurn({ bridgeOrigin: "http://127.0.0.1:1", bridgeSocket: join(dir, "inference.sock"), signal: AbortSignal.timeout(10000),
      command: { version: 1, kind: "bot.run", runId: binding.runId, route: resolved.route, systemPrompt: "Inspect the submitted images.", capabilities: [], limits: { maxToolActions: 1 },
        turn: { kind: "prompt", text: "Inspect", images: Array.from({ length: 4 }, () => ({ mimeType: "image/png", data: image })) } },
      broker: { loadSession: () => sessions.load(key), saveSession: async request => {
        const parsed = BotSessionSaveRequestSchema.parse(request);
        BotBrokerRequestSchema.parse({ version: 1, requestId: randomUUID(), runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, runId: binding.runId, action: "bot.session.save", session: parsed });
        expect(Buffer.byteLength(JSON.stringify(parsed.messages))).toBeLessThan(BOT_SESSION_MAX_BYTES); expect(JSON.stringify(parsed.messages)).not.toContain(image);
        return sessions.save({ ...key, ...parsed, tokenEstimate: 100, runtimeVersions: { pi: "fixture" }, now: new Date().toISOString() });
      }, event: async () => undefined, tool: async () => { throw new Error("No tools"); } } });
    expect(outcome).toMatchObject({ status: "completed", sessionRevision: 1 });
    const persisted = await sessions.load(key); expect(persisted.revision).toBe(1); expect(JSON.stringify(persisted.messages)).toContain("not kept in saved history");
    await bridge.close(); registry.release(binding.runtimeHandle);
    binding = { ...binding, runtimeHandle: `runtime_${"b".repeat(32)}`, executionGeneration: "2", runId: "run_followup" }; registry.bind(binding);
    // Production creates a fresh worker process/private socket namespace for each admitted turn.
    bridge = await startInferenceBridge({ brokerSocket: join(dir, "broker.sock"), socketPath: join(dir, "followup.sock"), botImages: true,
      runtimeHandle: binding.runtimeHandle, executionGeneration: "2", actionFor: request => inferenceActionForPath(request.url) });
    const followup = await runBotTurn({ bridgeOrigin: "http://127.0.0.1:1", bridgeSocket: join(dir, "followup.sock"), signal: AbortSignal.timeout(10000),
      command: { version: 1, kind: "bot.run", runId: binding.runId, route: resolved.route, systemPrompt: "Inspect the submitted images.", capabilities: [], limits: { maxToolActions: 1 }, turn: { kind: "prompt", text: "Continue with text" } },
      broker: { loadSession: () => sessions.load(key), saveSession: async request => {
        const parsed = BotSessionSaveRequestSchema.parse(request); expect(JSON.stringify(parsed.messages)).not.toContain(image);
        return sessions.save({ ...key, ...parsed, tokenEstimate: 100, runtimeVersions: { pi: "fixture" }, now: new Date().toISOString() });
      }, event: async () => undefined, tool: async () => { throw new Error("No tools"); } } });
    expect(followup).toMatchObject({ status: "completed", sessionRevision: 2 }); expect((await sessions.load(key)).revision).toBe(2);
    expect(frames).toBe(2); expect(nativeCalls).toBe(2); expect(noFunding).not.toHaveBeenCalled();
  } finally {
    await native.stop(); current = false; peers.close(); await bridge?.close(); await server?.close(); await state.destroy(); await rm(dir, { recursive: true, force: true });
  }
}, 20000);
