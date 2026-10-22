import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { BotToolRequestSchema, botToolDisplayInput, CanonicalChatRunActivitySchema, canonicalChatToolActivities } from "@matrix-os/contracts";
import { RemoteMcpClient } from "../../../packages/gateway/src/integrations/custom-mcp/client.js";
import { CustomMcpBroker } from "../../../packages/gateway/src/integrations/custom-mcp/broker.js";
import { createCustomMcpRoutes } from "../../../packages/gateway/src/integrations/custom-mcp/routes.js";
import { createManagedPiMcpClient } from "../../../packages/gateway/src/chat/managed-pi-mcp-client.js";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import { openToolOutput } from "../../../packages/gateway/src/coding-agents/protected-tool-output.mjs";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { PlatformDb } from "../../../packages/gateway/src/platform-db.js";
import type { CanonicalProviderRunEvent } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { mapBotEvent } from "../../../packages/gateway/src/bots/chat-adapter.js";
import { createBotStateDatabase } from "./bot-state-support.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createOwnerToolOutputProjection } from "../../../packages/gateway/src/chat/owner-tool-output.js";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { Kysely } from "kysely";
import { activityPersistenceId } from "../../../packages/gateway/src/chat/activity-persistence.js";
import type { McpProgressListener } from "../../../packages/gateway/src/integrations/custom-mcp/tool-progress.js";

it.each([true, false])("streams requester progress into encrypted same-tool events and durable replay (command=%s)", async command => {
  const serverId = "123e4567-e89b-42d3-a456-426614174000";
  const tool = { name: "echo", description: "Echo", inputSchema: { type: "object" }, enabled: true, approval: "allow" as const };
  const row = { id: serverId, url: "https://mcp.example.com/mcp", auth_mode: "none", enabled: true, status: "ready", revision: 1, enforcement_projection: [tool] };
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let remoteCalls = 0;
  const remote = new RemoteMcpClient({ requester: async request => {
    const body = request.body as { id?: number; method: string; params?: { _meta?: { progressToken?: string } } };
    if (body.method === "tools/call") {
      remoteCalls++;
      request.onNotification?.({ method: "notifications/progress", params: { progressToken: body.params?._meta?.progressToken, progress: 1, total: 2, message: "PHASE_ONE" } });
      await gate;
    }
    return { status: 200, headers: {}, body: { id: body.id, result: { protocolVersion: "2025-06-18", content: [{ type: "text", text: "FINAL_RESULT" }] } } };
  } });
  const broker = new CustomMcpBroker({ db: { getCustomMcpServerForBroker: async () => row } as unknown as PlatformDb,
    encryptionKey: Buffer.alloc(32), client: remote, projection: { upsert: async () => {}, remove: async () => {}, read: async () => ({ ...row, tools: [tool] }) as never } });
  const routes = createCustomMcpRoutes({ broker, resolveUserId: async () => "owner", allowToolCalls: true });
  const platform = new Hono(); platform.route("/internal/containers/owner/mcp-servers", routes);
  const mcp = createManagedPiMcpClient({ platformUrl: "https://platform.example.com", handle: "owner", ownerId: "owner", token: "fixture", fetcher: (url, init) => platform.request(url, init) });
  const key = Buffer.alloc(32, 7); const abort = new AbortController(); const events: CanonicalProviderRunEvent[] = [];
  const tools = createManagedPiOwnerTools({ toolOutputKey: key, mcp, signalFor: () => abort.signal,
    authority: async () => ({ permissionMode: "full_access" }), approvals: { registerRun: async () => ({ generation: 1 }), prepare: async () => ({ kind: "allow" }),
      revokeRun: async () => true } as never });
  const binding = { kind: "managed_chat", ownerId: "owner", chatId: "chat_live", runId: "run_live", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", capabilities: ["mcp.call"] } as ManagedPiRuntimeBinding;
  await tools.open(binding, event => { events.push(event); });
  const request = BotToolRequestSchema.parse({ toolCallId: "call_live", capability: "mcp.call", args: { serverId, tool: "echo", arguments: command ? { command: "printf proof" } : { limit: 1 } } });
  const display = botToolDisplayInput("mcp_call", request.args).display;
  const start = mapBotEvent({ type: "tool_progress", toolCallId: "call_live", capability: "mcp.call", phase: "started", display }, { toolOutputKey: key });
  let completed = false;
  const work = tools.dispatch(binding, request, abort.signal).then(result => { completed = true; return result; });
  try {
    await vi.waitFor(() => expect(events.some(event => event.type === "tool.output")).toBe(true));
    expect(completed).toBe(false);
    expect(JSON.stringify(events)).not.toContain("PHASE_ONE");
    const output = events.find(event => event.type === "tool.output")!;
    if (output.type !== "tool.output") throw new Error("Missing output");
    expect(openToolOutput(key, "call_live", output.protectedOutput)).toContain("PHASE_ONE");
    expect(events.find(event => event.type === "agent.activity")).toMatchObject({ activityId: "call_live", status: "running" });
    const initial = start.find(event => event.type === "agent.activity")!;
    if (initial.type !== "agent.activity") throw new Error("Missing initial activity");
    expect(events.find(event => event.type === "agent.activity")).toMatchObject({ activityId: initial.activityId, kind: initial.kind, label: initial.label });
    finish();
    await expect(work).resolves.toMatchObject({ ok: true, content: [{ text: expect.stringContaining("FINAL_RESULT") }] });
    expect(remoteCalls).toBe(1);
    const final = mapBotEvent({ type: "tool_progress", toolCallId: "call_live", capability: "mcp.call", phase: "completed", display: { ...display, output: "FINAL_RESULT" } }, { toolOutputKey: key });
    const { db, destroy } = await createBotStateDatabase();
    try {
      const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
      const { snapshot } = createCanonicalChatFixture("accepted"); const owner = { type: "personal" as const, ownerId: "owner" };
      const created = await repository.create(owner, { id: snapshot.chat.id, clientRequestId: "req_live", title: "Live" });
      const run = { ...snapshot.runs[0]!, driverKind: "matrix_pi" as const };
      await repository.admitTurn(owner, { chatId: created.chat.id, baseRevision: created.chat.revision, message: snapshot.messages[0]!, turn: snapshot.turns[0]!, run });
      for (const [index, event] of [...start, ...events, ...final].entries()) {
        await repository.appendRunActivities(owner, created.chat.id, run.id, [CanonicalChatRunActivitySchema.parse({ ...event,
          id: event.type === "agent.activity" ? activityPersistenceId(run.id, event) : `activity_live_${index}`, chatId: created.chat.id, runId: run.id, occurredAt: run.createdAt })]);
      }
      await repository.finishRun(owner, { chatId: created.chat.id, runId: run.id, outcome: "completed", completedAt: run.createdAt });
      const detail = createOwnerToolOutputProjection(key, [owner.ownerId])(owner, JSON.parse(JSON.stringify(await repository.getDetailPage(owner, created.chat.id, { limit: 20 }))));
      const cards = canonicalChatToolActivities(detail.runs[0]!, detail.activities);
      expect(cards).toHaveLength(1); expect(cards[0]).toMatchObject({ state: "completed" });
      expect(cards[0]!.detail).toContain("FINAL_RESULT"); expect(cards[0]!.detail).not.toContain("PHASE_ONE");
    } finally { await destroy(); }
  } finally { finish(); await work; await tools.closeRun(binding.runId); await broker.shutdown(); }
});

it.each([false, true])("bounds owner progress, withholds private context and ignores late output after Stop (private=%s)", async privateContext => {
  const key = Buffer.alloc(32, 7); const abort = new AbortController();
  const events: CanonicalProviderRunEvent[] = [];
  let notify!: McpProgressListener; let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const tools = createManagedPiOwnerTools({ toolOutputKey: key, signalFor: () => abort.signal,
    authority: async () => ({ permissionMode: "full_access" }), approvals: { registerRun: async () => ({ generation: 1 }), prepare: async () => ({ kind: "allow" }), revokeRun: async () => true } as never,
    mcp: { inventory: async () => [], describe: async () => ({}), call: async (_owner, _input, _signal, onProgress) => {
      notify = onProgress!; await gate; return { content: [] };
    } } });
  const binding = { kind: "managed_chat", ownerId: "owner", chatId: "chat_safe", runId: "run_safe", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", capabilities: ["mcp.call"] } as ManagedPiRuntimeBinding;
  await tools.open(binding, event => { events.push(event); });
  const request = BotToolRequestSchema.parse({ toolCallId: "call_safe", capability: "mcp.call", args: { serverId: "123e4567-e89b-42d3-a456-426614174000", tool: "echo", arguments: privateContext ? { token: "PRIVATE_CANARY" } : {} } });
  const work = tools.dispatch(binding, request, abort.signal);
  try {
    await vi.waitFor(() => expect(notify).toBeTypeOf("function"));
    for (let index = 0; index < 20; index++) notify({ progress: index, message: index === 1 ? "api_key=PRIVATE_CANARY" : "SAFE_PROGRESS" });
    const outputs = events.filter(event => event.type === "tool.output"); expect(outputs).toHaveLength(3);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_CANARY|SAFE_PROGRESS/);
    const text = outputs.map(event => openToolOutput(key, "call_safe", event.protectedOutput) ?? event.text).join("\n");
    expect(text).not.toContain("PRIVATE_CANARY");
    expect(text.includes("SAFE_PROGRESS")).toBe(!privateContext);
    expect(text).toContain("withheld"); expect(text).toContain("Live updates paused");
    abort.abort(); notify({ progress: 30, message: "LATE" }); expect(events).toHaveLength(6);
  } finally { finish(); await work; await tools.closeRun(binding.runId); }
});
