import type { KyselyPlugin } from "kysely";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { vi } from "vitest";
import type { CanonicalCliSpawn } from "../../../packages/gateway/src/chat/cli-process.js";
import { createClaudeChatProviderAdapter } from "../../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createRoutineCliRuntime } from "../../../packages/gateway/src/bots/routine-cli-runtime.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createRoutineCliExecutionRoutes } from "../../../packages/gateway/src/bots/routine-cli-routes.js";
import { createRoutineActionVerificationRoutes } from "../../../packages/platform/src/routine-action-routes.js";
import { authenticatedApprovalProxyProof } from "../../../packages/platform/src/canonical-owner-approval-proxy.js";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token.js";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { createRealBotStateDatabase, OWNER } from "./bot-state-support.js";
import { proposal, scope, TARGET_A } from "./routine-cli-request-support.js";
import type { CanonicalChatProviderAdapter, CanonicalProviderRunEvent } from "../../../packages/gateway/src/chat/provider-adapter.js";
export async function claudeFixture(options: { dbPlugin?: KyselyPlugin; sourceDriver?: "claude_code" | "codex" | "hermes" | "opencode" | "pi" } = {}) {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL; if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL required");
  let delegate: ReturnType<typeof createClaudeChatProviderAdapter>;
  let sourceAdapter: CanonicalChatProviderAdapter | undefined;
  const sourceDriver = options.sourceDriver ?? "claude_code", sourceInstance = sourceDriver + "_default";
  const sourceModel = sourceDriver === "hermes" ? "fixture:fixture-model" : "fixture-model";
  const sourceEvents: CanonicalProviderRunEvent[] = [];
  const data = await createRealBotStateDatabase(url), db = options.dbPlugin ? data.db.withPlugin(options.dbPlugin) : data.db;
  const f = await proposalFixture(db, vi.fn, {
    actualSourceOnly: sourceDriver === "opencode" || sourceDriver === "pi",
    adapters: [{ driverKind: sourceDriver, stateSchemaVersion: 1, parseState: value => value, serializeState: value => value,
      async *start(input) { for await (const event of (sourceAdapter ?? delegate).start(input)) { sourceEvents.push(event); yield event; } },
      async *resume(input) { const adapter = sourceAdapter ?? delegate; if (!adapter.resume) throw new Error("Fixture resume unsupported"); for await (const event of adapter.resume(input)) { sourceEvents.push(event); yield event; } },
      cancel: async input => { await (sourceAdapter ?? delegate).cancel?.({ owner: input.owner, chatId: input.chatId, runId: input.runId }); },
    }],
    catalog: { revision: "fixture", drivers: [{ kind: sourceDriver, displayName: "Claude", adapterVersion: "1", capabilityClass: "coding_agent" }], instances: [{ id: sourceInstance, driverKind: sourceDriver, displayName: "Claude", availability: "available", workspaceRequirement: "project_optional", catalogRevision: "fixture",
      models: [{ id: sourceModel, displayName: "Fixture", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }], options: [], skills: [], commands: [], setupActions: [],
      supports: { rootChat: true, resume: sourceDriver === "codex", cancellation: true, steering: "none", attachments: [], tools: [], approvals: true, userInput: false, worktrees: "none", resources: [], interactionModes: ["default", "review"], permissionModes: [["opencode", "pi"].includes(sourceDriver) ? "supervised" : "full_access"] } }] },
  }); f.state.clock = new Date().toISOString();
  const secret = "fixture-platform-claude-consent", handle = "computer-one", machineId = "machine_current";
  const machine = { machineId, handle, runtimeSlot: "primary", clerkUserId: OWNER, provisioningClass: "customer" as const };
  const platform = createRoutineActionVerificationRoutes({ platformSecret: secret, lookup: { resolveMachine: async () => ({ ...machine, status: "running" }) } });
  const actualFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => String(url).startsWith("https://platform.example.test") ? platform.request(new Request(url, init)) : actualFetch(url, init));
  const runtime = createRoutineCliRuntime({ db, computerId: scope.computerId, configuredOwnerIds: [OWNER], agents: f.agents, repository: f.chats,
    transact: f.transact, approvals: f.approvals, control: createBotRoutineExecution({ db, transact: f.transact, approvals: f.approvals, available: () => true }), registry: f.registry,
    platform: { platformUrl: "https://platform.example.test", handle, machineId, runtimeSlot: "primary", token: buildPlatformVerificationToken(handle, secret) } });
  runtime.bindCanonical(f.canonical); f.taskDependencies.routineProposals = runtime.proposals;
  const app = new Hono(); app.use("*", authMiddleware("fixture-owner-credential-never-native")); app.route("/", createRoutineCliExecutionRoutes({ requests: runtime }));
  let httpCalls = 0;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: request => { httpCalls++; return app.fetch(request); } });
  await new Promise<void>(done => { if (server.listening) done(); else server.once("listening", done); });
  const transport = { binPath: resolve("packages/sync-client/bin/matrix.mjs"), endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute` };
  async function admit(chatId: string, driverKind = "claude_code", modes = { permission: "full_access", interaction: "default" }) {
    const owner = { type: "personal" as const, ownerId: OWNER }; let detail = await f.chats.get(owner, chatId);
    if (!detail) { await f.chats.create(owner, { id: chatId, clientRequestId: "req_create_" + chatId, title: "Fixture" }); detail = (await f.chats.get(owner, chatId))!; }
    const turnId = `cturn_${chatId}`, runId = `run_${chatId}`, at = new Date().toISOString();
    await f.chats.admitTurn(owner, { chatId, baseRevision: detail.chat.revision,
      message: { id: `msg_${chatId}`, chatId, turnId, seq: detail.chat.messageCount + 1, role: "user", state: "committed", parts: [{ type: "text", text: "Fixture" }], createdAt: at },
      turn: { id: turnId, chatId, clientRequestId: `req_turn_${chatId}`, baseMessageSeq: detail.chat.messageCount, inputMessageId: `msg_${chatId}`, status: "accepted", createdAt: at, updatedAt: at },
      run: { id: runId, chatId, turnId, attempt: 1, driverKind: driverKind as "claude_code", instanceId: "claude_code_default", selection: { instanceId: "claude_code_default", model: "fixture-model" }, interactionMode: modes.interaction,
        permissionMode: modes.permission, status: "accepted", historyBoundarySeq: detail.chat.messageCount, createdAt: at, updatedAt: at,
        capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: true, userInput: true, resume: false, cancellation: true, worktrees: "none", interactionModes: [modes.interaction], permissionModes: [modes.permission] } } });
    return { owner, chatId, turnId, runId, prompt: "Fixture", parts: [{ type: "text" as const, text: "Fixture" }], selection: { instanceId: "claude_code_default", model: "fixture-model" }, interactionMode: modes.interaction, permissionMode: modes.permission, signal: new AbortController().signal };
  }
  async function approve(event: Extract<CanonicalProviderRunEvent, { type: "approval.requested" }>, chatId: string, runId: string) {
    const path = `/api/chats/${chatId}/runs/${runId}/approvals/${event.approvalId}`, body = { actionDigest: event.actionDigest!, decision: "approve" as const, clientRequestId: "de000000-0000-4000-8000-000000000099" };
    const proof = await authenticatedApprovalProxyProof({ request: new Request(`https://app.example.test${path}`, { method: "POST", body: JSON.stringify(body) }), method: "POST", path, handle, machine, platformSecret: secret,
      identity: { userId: OWNER, handle, runtimeSlot: "primary", source: "auth", sessionProvenance: "clerk-browser", sessionExpiresAt: Math.floor(Date.now() / 1000) + 300 } });
    return runtime.submitChat(OWNER, chatId, runId, event.approvalId, body, proof as string);
  }
  return { data, f, runtime, transport, admit, approve, sourceEvents,
    async start(chatId: string, modes = { permission: "full_access", interaction: "default" }) {
      const owner = { type: "personal" as const, ownerId: OWNER };
      await f.chats.create(owner, { id: chatId, clientRequestId: `req_create_${chatId}`, title: "Fixture" });
      return f.canonical.admitTurn(f.principal, owner, chatId, { clientRequestId: `req_turn_${chatId}`, baseRevision: 0, parts: [{ type: "text", text: "Fixture" }], selection: { instanceId: sourceInstance, model: sourceModel }, permissionMode: modes.permission, interactionMode: modes.interaction });
    },
    httpCalls: () => httpCalls,
    setSourceAdapter: (value: CanonicalChatProviderAdapter) => { sourceAdapter = value; },
    adapter: (spawnFn: CanonicalCliSpawn) => { delegate = createClaudeChatProviderAdapter({ homePath: f.home, spawnFn, resolveCredentialEnv: async () => ({}), routineCli: { runtime, ...transport } }); return delegate; },
    async close() { await f.canonical.close(); await runtime.close(); if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await f.close(); await data.destroy(); vi.unstubAllGlobals(); },
  };
}
/** Native transport/model is a named fixture. Actual adapter/source/CLI IPC/HTTP/Postgres/canonical admission stay real. */
export function nativeProtocol(command: string, version = "2.1.240") {
  const stdout = new EventEmitter(), stderr = new EventEmitter(), child = new EventEmitter();
  type Frame = { type: string; request_id: string; request?: { subtype: string; hooks: { PreToolUse: Array<{ hookCallbackIds: string[] }> } }; response?: { response?: { hookSpecificOutput?: { permissionDecision: string; updatedInput: { command: string } } } } };
  const frames: Frame[] = []; let callbackId = "", display: unknown, denied = false, promptCount = 0;
  const emit = (value: unknown) => stdout.emit("data", Buffer.from(JSON.stringify(value) + "\n"));
  const end = () => { emit({ type: "result", subtype: "success", result: "Fixture done", session_id: "fixture_session" }); child.emit("exit", 0, null); };
  const process = Object.assign(child, { stdout, stderr, stdin: { write(frame: string, done?: (error?: Error | null) => void) {
    const parsed = JSON.parse(frame); frames.push(parsed); done?.();
    if (parsed.request?.subtype === "initialize") { callbackId = parsed.request.hooks.PreToolUse[0].hookCallbackIds[0]; queueMicrotask(() => emit({ type: "control_response", response: { subtype: "success", request_id: parsed.request_id, response: { hooks_applied: true } } })); }
    if (parsed.type === "user") { promptCount++; queueMicrotask(() => {
      emit({ type: "system", subtype: "init", session_id: "fixture_session", claude_code_version: version, tools: ["Bash"] });
      emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Bash", id: "native_tool_one", input: {} } } });
      emit({ type: "control_request", request_id: "native_request_one", request: { subtype: "hook_callback", callback_id: callbackId, tool_use_id: "native_tool_one", input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "native_tool_one", permission_mode: "bypassPermissions", tool_input: { command, run_in_background: true } } } });
    }); }
    const hook = parsed.response?.response?.hookSpecificOutput;
    if (hook?.permissionDecision === "allow") { const path = /^\/bin\/cat -- '([^']+)'$/.exec(hook.updatedInput.command)?.[1]; if (!path) throw new Error("Unsafe display command"); void readFile(path, "utf8").then(text => { display = JSON.parse(text); if (!(display as { ok?: boolean }).ok) end(); }); }
    if (hook?.permissionDecision === "deny") { denied = true; queueMicrotask(end); }
    return true;
  }, end() {} }, kill() { queueMicrotask(() => child.emit("exit", null, "SIGTERM")); } });
  return { spawn: (() => process) as CanonicalCliSpawn, frames, display: () => display, denied: () => denied, promptCount: () => promptCount, end };
}
export { proposal, TARGET_A, scope };
