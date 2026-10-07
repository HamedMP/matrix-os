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
