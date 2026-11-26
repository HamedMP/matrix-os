import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../packages/gateway/src/bots/database.js";
import { MATRIX_BOT_INSTANCE_ID, MATRIX_BOT_SELECTION } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createBotTaskOrchestrator } from "../../packages/gateway/src/bots/task-orchestrator.js";
import { createMatrixBotChatProviderAdapter } from "../../packages/gateway/src/bots/chat-adapter.js";
import { createBotBindingsRepository } from "../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotSessionsRepository } from "../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotCheckpointsRepository } from "../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotStateTransactions } from "../../packages/gateway/src/bots/events.js";
import { BotRuntimeRegistry } from "../../packages/gateway/src/bots/runtime-registry.js";
import { createBotRecipeCatalog } from "../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBrokerActions } from "../../packages/gateway/src/bots/broker-actions.js";
import { createSlackSummarySubmitter, type SlackMentionSummaries } from "../../packages/gateway/src/slack/mention-summary.js";
import { runBotTurn } from "../../packages/bot-runtime/src/loop.js";
import { runCommandFromSpec } from "../../packages/bot-runtime/src/worker.js";
import { catalog } from "./chat-orchestrator-test-support.js";
export const SUMMARY_REPLY = "摘要：同事请求检查更改。\n建议待办：\n- [ ] 检查更改。\n来源：#tech；仅本次 thread，覆盖不完整。";
const sse = (text: string) => [
  ["message_start", { type: "message_start", message: { id: "msg_synthetic", type: "message", role: "assistant", content: [], model: "claude-sonnet-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 30 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
/** Real canonical admission, bot adapter, Pi loop and broker; only host allocation and provider HTTP are fixtures. */
export async function summaryRuntime(db: Kysely<OwnerBotDatabase>, summaries: SlackMentionSummaries, ownerId: string, botId: string) {
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const registry = new BotRuntimeRegistry();
  const lifetime = new AbortController();
  const modelRequests: Array<Record<string, unknown>> = [];
  let tasks: ReturnType<typeof createBotTaskOrchestrator>;
  const sessions = createBotSessionsRepository(db);
  const actions = createBotBrokerActions({ db, registry, sessions, checkpoints: createBotCheckpointsRepository(db),
    runs: { loadRunSpec: binding => tasks.runSource.loadRunSpec(binding), readImageChunk: async () => { throw new Error("No images"); } },
    events: { publish: (binding, event) => tasks.eventSink.publish(binding, event) },
    tools: { effectClass: () => "write", dispatch: async () => { throw new Error("Unexpected tool"); } },
    inference: { homePath: "/synthetic", lifetime: lifetime.signal, revalidateBinding: binding => summaries.assertAuthorized(binding), consumeReadonlyInference: binding => summaries.consumeInference(binding),
      resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic", ANTHROPIC_BASE_URL: "https://relay.invalid" } }),
      fetchImpl: async (_url, init) => { modelRequests.push(JSON.parse(String(init?.body))); return new Response(sse(SUMMARY_REPLY), { headers: { "content-type": "text/event-stream" } }); } },
  });
  let runtimeHandle = "";
  let runId = "";
  let ordinaryWait: Promise<void> | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk));
      const frame = { version: 1, requestId: randomUUID(), runtimeHandle, executionGeneration: "1", action: "inference.messages", method: "POST", path: request.url, headers: {}, body: Buffer.concat(chunks).toString() };
      const result = await actions.handleFrame(frame) as {
        ok: boolean;
        body?: string;
      };
      response.writeHead(result.ok ? 200 : 403, { "content-type": "text/event-stream" });
      response.end(result.body ?? "denied");
    })().catch(error => { response.writeHead(500); response.end(); console.warn("Synthetic bridge failed", error.name); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No bridge");
  const admission = { admit: async (input: Parameters<typeof registry.bind>[0]) => {
      runtimeHandle = `runtime_${randomUUID().replaceAll("-", "")}`;
      runId = input.runId;
      registry.bind({ ...input, runtimeHandle, executionGeneration: "1", rootFingerprint: "f".repeat(64) });
      return { runtimeHandle, executionGeneration: "1", rootFingerprint: "f".repeat(64) };
    }, release: async (handle: string) => { registry.release(handle); actions.forgetRun(runId); }, startRenewal: () => ({ stop: async () => { } }) };
  const frame = async (action: Record<string, unknown>) => {
    const result = await actions.handleFrame({ version: 1, requestId: randomUUID(), runtimeHandle, executionGeneration: "1", runId, ...action }) as {
      ok: boolean;
      result: unknown;
    };
    if (!result.ok)
      throw new Error("Synthetic broker refused");
    return result.result as never;
  };
  tasks = createBotTaskOrchestrator({ expectedOwnerId: ownerId, slackSummaries: summaries, bindings: createBotBindingsRepository(db), transact: createBotStateTransactions(repository),
    agents: { get: async () => ({ id: botId, name: "Personal Assistant", description: "", instructions: "Unrelated instruction", archived: false, selection: MATRIX_BOT_SELECTION, recipeRef: { recipeId: "personal-assistant", version: "2026-09-30.1" }, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) },
    recipes: createBotRecipeCatalog(), resolveRoute: async () => ({ route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200000, maxOutputTokens: 8192 }, accessSourceId: "matrix_included" }), admission, registry,
    client: { runBot: async (input) => {
        const binding = registry.lookupRun({ ...input, runId: input.command.runId })!;
        if (!binding.readonlySummary && ordinaryWait) {
          await ordinaryWait;
          return { ok: true, reply: { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 } };
        }
        const spec = await tasks.runSource.loadRunSpec(binding);
        const outcome = await runBotTurn({ command: runCommandFromSpec(input.command.runId, spec, []), bridgeOrigin: `http://127.0.0.1:${address.port}`, signal: input.signal,
          broker: { loadSession: () => frame({ action: "bot.session.load" }), saveSession: session => frame({ action: "bot.session.save", session }), tool: tool => frame({ action: "bot.tool", tool }), event: async (event) => { await frame({ action: "bot.event", event }); } } });
        return { ok: true, reply: outcome };
      } },
  });
  const provider = createMatrixBotChatProviderAdapter({ orchestrator: tasks, summaries, stopRuntime: admission.release });
  const c = catalog();
  c.drivers[0]!.kind = "matrix_bot";
  c.instances[0]!.driverKind = "matrix_bot";
  c.instances[0]!.id = MATRIX_BOT_INSTANCE_ID;
  c.instances[0]!.models[0]!.id = "auto";
  const canonical = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => c }, adapters: new CanonicalChatProviderRegistry([provider]) });
  summaries.attach(createSlackSummarySubmitter({ db, orchestrator: canonical }));
  return { canonical, repository, modelRequests, sessions, holdOrdinary() { let release!: () => void; ordinaryWait = new Promise<void>(resolve => { release = resolve; }); return release; }, async close() { await canonical.close(); lifetime.abort(); registry.shutdown(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
