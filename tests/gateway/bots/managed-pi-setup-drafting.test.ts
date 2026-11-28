import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import { BotBrokerError, type BotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
import { createBotStateDatabase, OWNER } from "./bot-state-support.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { ProjectSetupRepository } from "../../../packages/gateway/src/chat/project-setup-repository.js";
import { transitionProjectSetup } from "../../../packages/gateway/src/chat/project-setup-state.js";
import { projectSetupWorkspaceFingerprint } from "../../../packages/gateway/src/chat/project-setup-workspace.js";
import { generateProjectSetup, syncProjectSetupGeneration, syncProjectSetupResult } from "../../../packages/gateway/src/chat/project-setup-generation.js";
import { createManagedPiAdmission } from "../../../packages/gateway/src/chat/managed-pi-admission.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { createManagedPiSessionsRepository } from "../../../packages/gateway/src/chat/managed-pi-sessions.js";
import { createManagedPiCheckpointsRepository } from "../../../packages/gateway/src/chat/managed-pi-checkpoints.js";
import { managedPiChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import type { BotRunSpec, BotToolRequest, ProjectSetupAction, ProjectSetupResponse } from "@matrix-os/contracts";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { Kysely } from "kysely";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

it.each(["draft", "interview"] as const)("runs Matrix AI setup %s with zero tools, fresh ephemeral session, RO root and unchanged ordinary policy", async mode => {
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  const home = await mkdtemp(join(tmpdir(), "matrix-pi-setup-")); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "project"); await mkdir(root); await writeFile(join(root, "owner.txt"), "OWNER_CONTENT");
  const personality = { homePath: home, runtimeOwnerId: OWNER };
  await mkdir(join(home, "system"));
  await writeFile(join(home, "system/soul.md"), "PRIVATE_PERSONALITY_CANARY");
  const owner = { type: "personal" as const, ownerId: OWNER }, principal = { userId: OWNER, source: "jwt" as const };
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const ref = { kind: "project" as const, projectId: "project_setup" };
  const resolved = { ref, fingerprint: "a".repeat(64), primaryWorkspaceRoot: root, projectSlug: "setup" };
  const roots = { resolve: async () => resolved, revalidate: async () => resolved };
  const fingerprint = projectSetupWorkspaceFingerprint(resolved.fingerprint, await lstat(root));
  const setup = new ProjectSetupRepository(repository); let serial = 0;
  const interview = mode === "interview";
  const interviewContext = { project: { name: "Scoped interview" }, instructionFiles: ["AGENTS.md"], skills: [], mcpServices: [] };
  let current = await setup.start(owner, ref.projectId, fingerprint, interview
    ? { clientRequestId: "req_start", mode: "interview" } : { clientRequestId: "req_start", answer: "Portfolio" });
  const advance = (result: ProjectSetupResponse, action: ProjectSetupAction) => setup.mutate(owner, result.draft!.chatId, fingerprint,
    { clientRequestId: `req_step_${++serial}`, baseRevision: result.draft!.revision, action }, draft => transitionProjectSetup(draft, action));
  if (!interview) {
    current = await advance(current, { type: "answer", text: "Run relevant checks" });
    current = await advance(current, { type: "choose_skill", choice: "skip" });
    current = await advance(current, { type: "choose_mcp", choice: "skip" });
  }
  const snapshot = makeAiProviderSnapshot(), selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  const sessions = createManagedPiSessionsRepository(db);
  await sessions.save({ ownerId: OWNER, chatId: current.draft!.chatId, baseRevision: 0,
    messages: [{ role: "user", content: "PRIVATE_BROADER_SESSION_CANARY", timestamp: Date.now() }], tokenEstimate: 5, runtimeVersions: {}, now: new Date().toISOString() });
  const sessionLoad = vi.spyOn(sessions, "load"), sessionSave = vi.spyOn(sessions, "save");
  const registry = new BotRuntimeRegistry();
  const handle = fauxProvider({ models: [{ id: selection.model, input: ["text"], contextWindow: 128000, maxTokens: 8192 }] });
  const contexts: Array<{ tools?: unknown[]; messages: unknown[] }> = [];
  handle.setResponses([
    fauxAssistantMessage(fauxText(JSON.stringify(interview
      ? { reply: "What should we build with this project?", focus: "intent", suggestions: ["A release checklist"] }
      : { guidance: "# Guidance\n\nRun relevant checks." }))),
    fauxAssistantMessage(fauxText("An ordinary follow-up.")),
  ].map(message => context => { contexts.push(structuredClone(context) as never); return message; }));
  const specs: BotRunSpec[] = [], forged: unknown[] = [];
  let setupFrame: { runtimeHandle: string; executionGeneration: string; runId: string } | undefined;
  const toolPrepare = vi.fn(async () => undefined), toolDispatch = vi.fn(async () => { throw new Error("Unexpected effect"); });
  const createRuntime = vi.fn(async (_request: Parameters<ScopeRuntimeHost["client"]["createRuntime"]>[0]) => ({ runtimeHandle: `runtime_${(++serial).toString(16).padStart(32, "0")}`, executionGeneration: "1" }));
  let actions: ReturnType<typeof createBotBrokerActions>;
  const stopRuntime = async ({ runtimeHandle }: Parameters<ScopeRuntimeHost["client"]["stopRuntime"]>[0]) => ({
    runtimeHandle, executionGeneration: "1", state: "stopped" as const,
  });
  const host = { available: true, client: { createRuntime, stopRuntime, renewRuntime: async () => undefined,
    runBot: async (request: { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string } }) => {
      const frame = (body: Record<string, unknown>) => ({ version: 1, requestId: randomUUID(), runtimeHandle: request.runtimeHandle,
        executionGeneration: request.executionGeneration, runId: request.command.runId, ...body });
      const call = async (body: Record<string, unknown>) => {
        const reply = await actions.handleFrame(frame(body));
        if (!reply?.ok) throw new BotBrokerError((reply?.code ?? "unavailable") as never);
        return reply.result;
      };
      const spec = await call({ action: "bot.run.load" }) as BotRunSpec; specs.push(spec);
      if (specs.length === 1) {
        setupFrame = { runtimeHandle: request.runtimeHandle, executionGeneration: request.executionGeneration, runId: request.command.runId };
        const requests: BotToolRequest[] = [
          { toolCallId: "call_write", capability: "artifact.write", args: { relPath: "owner.txt", content: "FORGED", mimeType: "text/plain" } },
          { toolCallId: "call_browser", capability: "browser.action", args: { action: "navigate", url: "https://example.com" } },
          { toolCallId: "call_routine", capability: "routine.cli", args: { operation: "pause", routineId: `rt_${"a".repeat(24)}`, baseRevision: 1, requestId: randomUUID() } },
          { toolCallId: "call_integration", capability: "integration.call", args: { service: "github", connectionId: "conn_qa", action: "create_issue", params: {} } },
        ];
        for (const tool of requests) forged.push(await actions.handleFrame(frame({ action: "bot.tool", tool, ...(tool.capability === "routine.cli" ? { transport: "live" } : {}) })));
        forged.push(await actions.handleFrame(frame({ action: "bot.session.save", session: { baseRevision: 8, messages: [] } })));
        forged.push(await actions.handleFrame(frame({ action: "bot.session.save", session: { baseRevision: 0, messages: [], recompactionHandled: true } })));
      }
      const broker: BotBrokerClient = { loadSession: () => call({ action: "bot.session.load" }) as never,
        saveSession: session => call({ action: "bot.session.save", session }) as never,
        event: async event => { await call({ action: "bot.event", event }); }, tool: tool => call({ action: "bot.tool", tool }) as never };
      const reply = await runBotTurn({ command: { ...spec, version: 1, kind: "bot.run", runId: request.command.runId }, broker,
        bridgeOrigin: "http://127.0.0.1:41000", route: { provider: handle.provider, model: handle.getModel() } });
      return { ok: true, reply };
    } } } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db, homePath: home, host, registry, roots, toolCapabilities: ["routine.cli", "browser.action", "integration.call"] });
  const ownerTools = { open: vi.fn(async () => undefined), closeRun: vi.fn(async () => undefined), submit: vi.fn() };
  const inputHistory = vi.fn(async () => ({ references: [], assertCurrent: async () => undefined }));
  const runtime = createManagedPiRuntime({ homePath: home, expectedOwnerId: OWNER, admission, host, ownerTools: ownerTools as never, inputHistory, personality,
    providers: { getSnapshot: async () => snapshot }, lifetime: new AbortController().signal,
    forgetRun: id => actions.forgetRun(id), cancelInference: binding => registry.cancelInference(binding) });
  actions = createBotBrokerActions({ db, registry, sessions: createBotSessionsRepository(db), managedSessions: sessions,
    checkpoints: createBotCheckpointsRepository(db), managedCheckpoints: createManagedPiCheckpointsRepository(db),
    runs: runtime.runs, events: runtime.events, tools: { prepare: toolPrepare, effectClass: () => "write", dispatch: toolDispatch },
    inference: { homePath: home, lifetime: new AbortController().signal } });
  const catalog = { getCatalog: async () => ({ revision: "setup_test", drivers: [{ kind: "matrix_pi" as const, displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" as const }],
    instances: managedPiChatInstances(snapshot).map(instance => ({ ...instance, catalogRevision: "setup_test" })) }) };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters: new CanonicalChatProviderRegistry([runtime.adapter]), executionRoots: roots });
  cleanup.push(async () => { await orchestrator.close(); await runtime.close(); });
  if (!interview) current = await advance(current, { type: "generate", selection });
  const generation = await generateProjectSetup({ repository, orchestrator, catalog }, principal, owner, current.draft!, selection, "req_generate",
    resolved.fingerprint, interview ? interviewContext : undefined);
  expect(generation.status).toBe("running"); await orchestrator.drain();
  const pending = { ...current.draft!, generation };
  if (interview) {
    const result = await syncProjectSetupResult(repository, owner, pending, resolved.fingerprint, { runId: generation.runId!, context: interviewContext });
    expect(result.draft.generation?.status).toBe("completed");
    expect(result.draft.interview?.suggestions).toEqual(["A release checklist"]);
    expect(result.assistantText).toBe("What should we build with this project?");
    expect(specs[0]?.systemPrompt).not.toContain("PRIVATE_PERSONALITY_CANARY");
    expect(specs[0]?.limits.maxInferenceCalls).toBe(1);
    expect(JSON.stringify(contexts[0])).toContain("Scoped interview");
  } else {
    const generated = await syncProjectSetupGeneration(repository, owner, pending, resolved.fingerprint);
    expect(generated.generation?.status).toBe("completed");
    expect(generated.proposals[0]?.content).toContain("relevant checks");
  }
  expect(specs[0]?.capabilities).toEqual([]); expect(contexts[0]?.tools ?? []).toEqual([]);
  expect(JSON.stringify(contexts[0])).not.toContain("PRIVATE_BROADER_SESSION_CANARY");
  expect(ownerTools.open).not.toHaveBeenCalled(); expect(inputHistory).not.toHaveBeenCalled();
  expect(sessionLoad).not.toHaveBeenCalled(); expect(sessionSave).not.toHaveBeenCalled();
  expect(await actions.handleFrame({ version: 1, requestId: randomUUID(), ...setupFrame, action: "bot.session.save",
    session: { baseRevision: 0, messages: [] } })).toMatchObject({ ok: false, code: "stale_generation" });
  expect(forged.slice(0, 4)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ ok: false, code: "denied" })));
  expect(forged.slice(4)).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ ok: false })));
  expect(toolPrepare).not.toHaveBeenCalled(); expect(toolDispatch).not.toHaveBeenCalled();
  expect(await db.selectFrom("managed_pi_tool_checkpoints").selectAll().execute()).toHaveLength(0);
  expect(await readFile(join(root, "owner.txt"), "utf8")).toBe("OWNER_CONTENT");
  expect(createRuntime.mock.calls[0]?.[0]).toMatchObject({ sandbox: { network: "broker_only", worktree: { mode: "ro" } } });
  const record = await repository.get(owner, current.draft!.chatId);
  await orchestrator.admitTurn(principal, owner, current.draft!.chatId, { clientRequestId: "req_followup", baseRevision: record!.chat.revision,
    parts: [{ type: "text", text: "An ordinary follow-up" }], selection, interactionMode: "default", permissionMode: "full_access" });
  await orchestrator.drain();
  expect(specs[1]?.capabilities).toContain("artifact.write"); expect(ownerTools.open).toHaveBeenCalledTimes(1);
  expect(sessionLoad).toHaveBeenCalledTimes(1); expect(sessionSave).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(contexts[1])).toContain("PRIVATE_BROADER_SESSION_CANARY");
  expect(specs[1]?.systemPrompt).toContain("PRIVATE_PERSONALITY_CANARY");
  expect(createRuntime.mock.calls[1]?.[0]).toMatchObject({ sandbox: { worktree: { mode: "rw" } } });
});
