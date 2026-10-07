import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Kysely } from "kysely";
import type { BotToolRequest } from "@matrix-os/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createBotStateDatabase, OWNER } from "./bot-state-support.js";
import { startBots } from "../../../packages/gateway/src/startup/bots.js";
import * as broker from "../../../packages/gateway/src/bots/broker-actions.js";
import * as integrationTools from "../../../packages/gateway/src/bots/integration-tools.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { createBotWorkspace, resolveBotWorkspaceRoot } from "../../../packages/gateway/src/chat/bot-workspace-root.js";
import { createMatrixAnthropicConnectionService } from "../../../packages/gateway/src/ai-providers/matrix-anthropic-connection.js";
import { createMatrixAnthropicSourceStore } from "../../../packages/gateway/src/ai-providers/matrix-anthropic-source.js";
import { createNativeProviderProfileGuard } from "../../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { revokeOwnerAnthropicKey } from "../../../packages/gateway/src/ai-providers/owner-anthropic-key.js";
import { storeApiKey } from "../../../packages/gateway/src/onboarding/api-key.js";

const cleanup: Array<() => Promise<unknown>> = []; // bounded by fixture count, drained after each test
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  const home = await mkdtemp(join(tmpdir(), "matrix-recipe-source-"));
  cleanup.push(async () => { await rm(home, { recursive: true, force: true }); await rm(join(dirname(home), ".matrix-private", basename(home)), { recursive: true, force: true }); });
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const agents = new ChatAgentStore({ homePath: home, db: repository.kysely }); await agents.bootstrap(); cleanup.push(() => agents.close());
  const guard = createNativeProviderProfileGuard({ homePath: home, registry: {
    async get() { throw Object.assign(new Error("Fixture terminal absent"), { code: "session_not_found" }); }, async observeAgentLiveness() { return "stopped"; },
  } });
  const service = createMatrixAnthropicConnectionService({ homePath: home, ownerId: OWNER,
    sourceStore: createMatrixAnthropicSourceStore({ homePath: home, profileGuard: guard }), supports: { rootChat: true, recipeBots: true },
    fetch: vi.fn(async () => Response.json({ data: [{ type: "model", id: "claude-synthetic", display_name: "Synthetic Claude", max_input_tokens: 200000, max_tokens: 8192 }], has_more: false, last_id: "claude-synthetic" })),
  }); cleanup.push(() => service.shutdown());
  const connected = await service.connect(OWNER, { apiKey: "sk-ant-source-synthetic", expectedRevision: 0, expectedCredentialGeneration: null, idempotencyKey: "connect-source" });
  const call = vi.fn(async () => ({ ok: true as const, content: [{ type: "text" as const, text: "integration result" }] }));
  vi.spyOn(integrationTools, "createBotIntegrationTools").mockReturnValue({ inventory: call, call } as never);
  const captured = vi.spyOn(broker, "createBotBrokerActions");
  const services = await startBots({ homePath: home, repository, agents, matrixAnthropic: service,
    executionRoots: { resolve: vi.fn() }, providers: { getSnapshot: vi.fn() },
    integrations: vi.fn(async () => Response.json([])),
    host: { available: true, client: { runBot: vi.fn(), stopRuntime: vi.fn(), createRuntime: vi.fn() }, registerAuthorizer: vi.fn(() => () => {}) } as never,
  }); cleanup.push(() => services!.close());
  const botId = "bot_sourcefence"; await createBotWorkspace({ homePath: home, botId });
  const root = await resolveBotWorkspaceRoot({ homePath: home, owner: { type: "personal", ownerId: OWNER }, ref: { kind: "bot_workspace", botId } });
  const binding: BotRuntimeBinding = { runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "1", ownerId: OWNER, botId,
    chatId: "chat_sourcefence", taskId: "task_sourcefence", runId: "run_sourcefence", rootFingerprint: root.fingerprint,
    route: { api: "anthropic-messages", modelId: "claude-synthetic", input: ["text"], contextWindow: 200000, maxOutputTokens: 8192 },
    accessSourceId: "owner_anthropic_key", anthropicApi: { connectionRevision: connected.revision, credentialGeneration: connected.credentialGeneration! },
    capabilities: ["artifact.write", "integration.call"], requestClass: "interactive" };
  return { home, root: root.primaryWorkspaceRoot, call, service, binding, tools: captured.mock.calls[0]![0].tools };
}
const artifact: BotToolRequest = { toolCallId: "call_artifact", capability: "artifact.write", args: { relPath: "result.txt", content: "source fenced", mimeType: "text/plain" } };
const integration: BotToolRequest = { toolCallId: "call_integration", capability: "integration.call", args: { service: "gmail", action: "send_email", connectionId: "conn_fixture", params: {} } };
it("keeps a current recipe source usable for artifact and Integration dispatch", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await f.tools.prepare!(f.binding, artifact, signal); await f.tools.dispatch(f.binding, artifact, signal);
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("source fenced");
  await f.tools.prepare!(f.binding, integration, signal); await f.tools.dispatch(f.binding, integration, signal);
  expect(f.call).toHaveBeenCalledTimes(1);
});
it.each(["removal", "replacement"])("fences preparation and dispatch after native key %s without needing an aborted run signal", async mutation => {
  const f = await fixture(), signal = new AbortController().signal;
  await f.tools.prepare!(f.binding, artifact, signal); await f.tools.prepare!(f.binding, integration, signal);
  if (mutation === "removal") await revokeOwnerAnthropicKey(f.home); else await storeApiKey(f.home, "sk-ant-replacement-synthetic");
  expect(signal.aborted).toBe(false);
  for (const request of [artifact, integration]) {
    await expect(f.tools.prepare!(f.binding, request, signal)).rejects.toMatchObject({ code: "stale_generation" });
    await expect(f.tools.dispatch(f.binding, request, signal)).rejects.toMatchObject({ code: "stale_generation" });
  }
  await expect(readFile(join(f.root, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.call).not.toHaveBeenCalled();
});
