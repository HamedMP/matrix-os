import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { chatGptPlanPeerProof, MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { createBotStateDatabase, OWNER, OTHER_OWNER, BOT } from "./bot-state-support.js";
import { createChatGptPlanPeers } from "../../../packages/gateway/src/bots/chatgpt-plan-peers.js";
import { withChatGptPlanProviderInstance } from "../../../packages/gateway/src/bots/chatgpt-plan-provider-instance.js";
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import { createManagedPiAdmission } from "../../../packages/gateway/src/chat/managed-pi-admission.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { resolveManagedPiSelection } from "../../../packages/gateway/src/chat/managed-pi-route.js";
import { chatCatalogDiscoveryScope } from "../../../packages/gateway/src/chat/catalog-discovery-scope.js";
import { createChatExecutionRootResolver } from "../../../packages/gateway/src/chat/execution-root.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const modelId = "gpt-account-model";
const wire = JSON.stringify({ model: modelId, input: [{ role: "user", content: "Hello" }], stream: true, store: false });
const completed = `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", model: modelId } })}\n\n`;

async function fixture(rootKind?: "project" | "worktree") {
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  const home = await mkdtemp(join(tmpdir(), "matrix-plan-chat-")); cleanup.push(() => rm(home, { force: true, recursive: true }));
  const project = { id: "project_plan", slug: "plan-qa", localPath: join(home, "projects", "plan-qa") };
  const worktree = { id: "wt_abc123def456", projectSlug: project.slug, path: join(home, "worktrees", project.slug, "wt_abc123def456"), createdAt: "2026-10-07T00:00:00Z" };
  if (rootKind) { await mkdir(project.localPath, { recursive: true }); await mkdir(worktree.path, { recursive: true }); }
  const executionRoot = rootKind === "project" ? { kind: "project" as const, projectId: project.id }
    : rootKind === "worktree" ? { kind: "worktree" as const, projectId: project.id, worktreeId: worktree.id } : undefined;
  const executionRoots = rootKind ? createChatExecutionRootResolver({ homePath: home,
    projects: { getProjectById: async (scope, id) => scope.id === OWNER && id === project.id ? { ok: true, project } : { ok: false, status: 403, error: {} }, resolveProjectWorkingDirectory: async () => project.localPath },
    worktrees: { getWorktree: async (slug, id, scope) => scope.id === OWNER && slug === project.slug && id === worktree.id ? { ok: true, worktree } : { ok: false, status: 403, error: {} } },
  }) : undefined;
  const peers = createChatGptPlanPeers({ db, ownerId: OWNER, computerId: "main" }); cleanup.push(async () => peers.close());
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" });
  const snapshot = { deviceId: createHash("sha256").update(publicKey).digest("hex"), accountId: "account_own",
    grantRevision: 3, enabled: true, background: false,
    models: [{ id: modelId, displayName: "Account model", input: ["text" as const], contextWindow: 128000, maxOutputTokens: 8192 }] };
  const connect = async (next = snapshot) => {
    const challenge = peers.challenge(OWNER);
    return peers.connect(OWNER, { version: 1, challenge: challenge.challenge, publicKey: publicKey.toString("base64url"), snapshot: next,
      signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot: next })), keys.privateKey).toString("base64url") });
  };
  const session = await connect();
  const catalog = withChatGptPlanProviderInstance({ getCatalog: async () => ({ revision: "test", drivers: [], instances: [] }) }, peers, () => true);
  const source = (await catalog.getCatalog({ userId: OWNER, source: "jwt" })).instances.find(i => i.id === MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID)!;
  const selection = source.defaultSelection!;
  const registry = new BotRuntimeRegistry(); cleanup.push(async () => registry.shutdown());
  const providers = { getSnapshot: vi.fn(async () => { throw new Error("Funded discovery must not run"); }) };
  const createRuntime = vi.fn(async () => ({ runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "2", state: "running" }));
  let finish: () => void = () => undefined;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  let binding: ManagedPiRuntimeBinding | undefined;
  const runBot = vi.fn(async (input: { command: { kind: string; runId: string }; runtimeHandle: string; executionGeneration: string }) => {
    if (input.command.kind === "bot.cancel") { finish(); return { ok: true, reply: { runId: input.command.runId, status: "aborted", toolActions: 0, sessionRevision: 1 } }; }
    binding = registry.lookupRun({ ...input, runId: input.command.runId }) as ManagedPiRuntimeBinding;
    await hold;
    return { ok: true, reply: { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 } };
  });
  const host = { available: true, client: { createRuntime, runBot, stopRuntime: vi.fn(async () => undefined) } } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db, homePath: home, host, registry, chatgptPlan: peers, roots: executionRoots ?? { resolve: async () => { throw new Error("No project"); } } });
  const runtime = createManagedPiRuntime({ admission, host, providers, chatgptPlan: peers, lifetime: new AbortController().signal,
    forgetRun: () => undefined, cancelInference: current => registry.cancelInference(current) });
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters: new CanonicalChatProviderRegistry([runtime.adapter]), ...(executionRoots ? { executionRoots } : {}) });
  cleanup.push(async () => { finish(); await orchestrator.drain(); await runtime.close(); await orchestrator.close(); });
  const owner = { type: "personal" as const, ownerId: OWNER };
  await repository.create(owner, { id: "chat_plan", clientRequestId: "req_plan", title: "Own plan", ...(rootKind ? { projectId: project.id } : {}) });
  const start = async () => {
    const result = await orchestrator.admitTurn({ userId: OWNER, source: "jwt" }, owner, "chat_plan", {
      clientRequestId: "req_plan_turn", baseRevision: 0, selection, interactionMode: "default", permissionMode: "supervised", parts: [{ type: "text", text: "Hello" }],
      ...(executionRoot ? { executionRoot } : {}),
    });
    await vi.waitFor(() => expect(binding).toBeDefined());
    return { result, binding: binding! };
  };
  const resolveCredentials = vi.fn(), fundedAdmission = { execute: vi.fn() }, fetchImpl = vi.fn();
  const forward = (bound: ManagedPiRuntimeBinding) => forwardBotInference({ version: 1, action: "inference.responses", requestId: randomUUID(),
    runtimeHandle: bound.runtimeHandle, executionGeneration: bound.executionGeneration, path: "/v1/responses", headers: {}, body: wire }, bound,
  selected => registry.authorize({ ...bound, action: "inference.responses", modelId: selected }), {
    homePath: home, lifetime: new AbortController().signal, runSignal: registry.inferenceSignal(bound)!, chatgptPlan: peers,
    revalidateBinding: async candidate => { try { await admission.toolAuthority(candidate as ManagedPiRuntimeBinding); return true; } catch { return false; } },
    resolveCredentials, fundedAdmission, fetchImpl,
  } as never);
  const noFallback = () => { expect(providers.getSnapshot).not.toHaveBeenCalled(); expect(resolveCredentials).not.toHaveBeenCalled(); expect(fundedAdmission.execute).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled(); };
  return { db, peers, session, snapshot, connect, source, selection, providers, registry, admission, runtime, start, forward, noFallback, createRuntime, finish,
    expectedWorkspaceRoot: rootKind ? await realpath(rootKind === "worktree" ? worktree.path : project.localPath) : undefined };
}

it("runs the actual ordinary catalog selection through canonical admission, Pi runtime and the paired native broker twice", async () => {
  const f = await fixture(); const { binding, result } = await f.start();
  expect(binding).toMatchObject({ kind: "managed_chat", accessSourceId: "matrix_chatgpt_plan", subscription: { accountId: "account_own", computerId: "main", grantRevision: 3 }, capabilities: ["artifact.read"] });
  expect(binding).not.toHaveProperty("botId"); expect(binding).not.toHaveProperty("taskId");
  expect((await f.runtime.runs.loadRunSpec(binding)).route).toEqual(binding.route);
  expect(result.run.selection).toEqual(f.selection);
  for (let call = 0; call < 2; call++) {
    const pending = f.forward(binding);
    const request = (await f.peers.poll(OWNER, f.session)).requests.find(r => r.action === "infer");
    expect(request).toMatchObject({ model: modelId, accountId: "account_own", computerId: "main", grantRevision: 3, requestClass: "interactive" });
    f.peers.reply(OWNER, { ...f.session, id: request!.id, ok: true, status: 200, headers: { "content-type": "text/event-stream" }, body: completed });
    expect(await pending).toMatchObject({ ok: true, body: completed });
  }
  f.noFallback(); f.finish();
});

it("normalizes only the explicit ordinary source and refuses forged account/grant/model or native/Bot aliases without funding fallback", async () => {
  const f = await fixture();
  for (const selection of [
    { ...f.selection, instanceId: "matrix_chatgpt_plan" }, { ...f.selection, instanceId: "codex_default" },
    { ...f.selection, model: "invented" }, { ...f.selection, options: [] },
    { ...f.selection, options: [{ id: "accountId", value: "other" }, { id: "grantRevision", value: "3" }] },
    { ...f.selection, options: [{ id: "accountId", value: "account_own" }, { id: "grantRevision", value: "2" }] },
    { ...f.selection, options: [...f.selection.options!, f.selection.options![0]!] },
  ]) await expect(resolveManagedPiSelection(selection, OWNER, { providers: f.providers, chatgptPlan: f.peers })).rejects.toThrow();
  await expect(resolveManagedPiSelection(f.selection, OTHER_OWNER, { providers: f.providers, chatgptPlan: f.peers })).rejects.toThrow();
  await expect(resolveManagedPiSelection(f.selection, OWNER, { providers: f.providers })).rejects.toThrow();
  f.noFallback();
});

it.each(["shared", "bot", "wrong_owner", "wrong_instance"])("refuses %s persisted ordinary admission before creating another runtime", async kind => {
  const f = await fixture();
  // The real canonical run holds execution; changes must revoke later admission and tool authority.
  const { binding } = await f.start();
  const resolved = { route: binding.route, accessSourceId: binding.accessSourceId, subscription: binding.subscription };
  if (kind === "shared") await f.db.updateTable("chats").set({ collaboration: { version: 1 } as never }).where("id", "=", binding.chatId).execute();
  if (kind === "bot") await createBotBindingsRepository(f.db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: binding.chatId, now: new Date().toISOString() });
  if (kind === "wrong_instance") await f.db.updateTable("chat_runs").set({ instance_id: "matrix_chatgpt_plan" }).where("id", "=", binding.runId).execute();
  const count = f.createRuntime.mock.calls.length;
  await expect(f.admission.admit({ ownerId: kind === "wrong_owner" ? OTHER_OWNER : OWNER, chatId: binding.chatId, runId: binding.runId, resolved })).rejects.toThrow();
  expect(f.createRuntime).toHaveBeenCalledTimes(count); await expect(f.admission.toolAuthority({ ...binding, ownerId: kind === "wrong_owner" ? OTHER_OWNER : OWNER })).rejects.toThrow();
  if (kind === "shared") await f.db.updateTable("chats").set({ collaboration: null }).where("id", "=", binding.chatId).execute();
  if (kind === "wrong_instance") await f.db.updateTable("chat_runs").set({ instance_id: f.selection.instanceId }).where("id", "=", binding.runId).execute();
  f.noFallback();
});

it("rejects persisted source changes during inference and fences continuation and tool authority", async () => {
  const f = await fixture(); const { binding } = await f.start();
  const pending = f.forward(binding);
  const request = (await f.peers.poll(OWNER, f.session)).requests[0]!;
  await f.db.updateTable("chat_runs").set({ selection: { ...f.selection, options: [{ id: "accountId", value: "replaced" }, { id: "grantRevision", value: "3" }] } }).where("id", "=", binding.runId).execute();
  f.peers.reply(OWNER, { ...f.session, id: request.id, ok: true, status: 200, headers: { "content-type": "text/event-stream" }, body: completed });
  expect(await pending).toMatchObject({ ok: false, error: "action_denied" });
  await expect(f.admission.toolAuthority(binding)).rejects.toThrow();
  expect(await f.forward(binding)).toMatchObject({ ok: false, error: "action_denied" }); f.noFallback();
});

it.each(["root", "fingerprint"])("rejects changed persisted %s provenance before an admitted personal source can use tools", async field => {
  const f = await fixture(); const { binding } = await f.start();
  await expect(f.admission.toolAuthority(binding)).resolves.toEqual({ permissionMode: "supervised" });
  await f.db.updateTable("chat_runs").set(field === "root"
    ? { execution_root: { kind: "project", projectId: "project_replaced" } }
    : { execution_root_fingerprint: "f".repeat(64) }).where("id", "=", binding.runId).execute();
  await expect(f.admission.workspace(binding)).rejects.toThrow();
  await expect(f.admission.toolAuthority(binding)).rejects.toThrow();
  expect(await f.forward(binding)).toMatchObject({ ok: false, error: "action_denied" });
  f.noFallback();
});

it.each(["project", "worktree"] as const)("retains authorized %s provenance and refuses a changed persisted fingerprint", async kind => {
  const f = await fixture(kind); const { binding } = await f.start();
  expect(await f.admission.workspace(binding)).toBe(f.expectedWorkspaceRoot);
  await expect(f.admission.toolAuthority(binding)).resolves.toEqual({ permissionMode: "supervised" });
  const pending = f.forward(binding);
  const request = (await f.peers.poll(OWNER, f.session)).requests[0]!;
  await f.db.updateTable("chat_runs").set({ execution_root_fingerprint: "f".repeat(64) }).where("id", "=", binding.runId).execute();
  f.peers.reply(OWNER, { ...f.session, id: request.id, ok: true, status: 200, headers: { "content-type": "text/event-stream" }, body: completed });
  expect(await pending).toMatchObject({ ok: false, error: "action_denied" });
  await expect(f.admission.toolAuthority(binding)).rejects.toThrow();
  f.noFallback();
});

it("replacement grant/peer and disconnect cannot reuse an admitted subscription binding", async () => {
  const f = await fixture(); const { binding } = await f.start();
  const replacement = await f.connect({ ...f.snapshot, grantRevision: 4 });
  await expect(f.admission.toolAuthority(binding)).rejects.toThrow();
  expect(await f.forward(binding)).toMatchObject({ ok: false, error: "action_denied" });
  f.peers.disconnect(OWNER, replacement);
  await expect(resolveManagedPiSelection(f.selection, OWNER, { providers: f.providers, chatgptPlan: f.peers })).rejects.toThrow(); f.noFallback();
});

it("Stop cancels the exact native inference, denies late continuation and preserves source isolation", async () => {
  const f = await fixture(); const { binding } = await f.start();
  const pending = f.forward(binding);
  const request = (await f.peers.poll(OWNER, f.session)).requests[0]!;
  await f.runtime.adapter.cancel!({ owner: { type: "personal", ownerId: OWNER }, chatId: binding.chatId, runId: binding.runId });
  expect(await pending).toMatchObject({ ok: false, error: "action_denied" });
  expect((await f.peers.poll(OWNER, f.session)).requests).toEqual([{ version: 1, action: "cancel", id: request.id }]);
  expect(await f.forward(binding)).toMatchObject({ ok: false, error: "action_denied" }); f.noFallback();
});

it("discovers only the new ordinary source scope without probing funded or native-provider models", () => {
  const selection: CanonicalChatModelSelection = { instanceId: MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, model: modelId };
  const scope = chatCatalogDiscoveryScope(selection);
  expect(scope).toMatchObject({ readAi: false, readRuntime: false, coding: [], systems: [] });
  expect(scope.acceptsDriver("matrix_pi")).toBe(true);
  expect(scope.acceptsInstance("matrix_chatgpt_plan")).toBe(false);
  expect(scope.acceptsDriver("codex")).toBe(false);
});


it("refuses an admission route with forged peer, account, API or model limits before another runtime starts", async () => {
  const f = await fixture(); const { binding } = await f.start();
  const resolved = { route: binding.route, accessSourceId: binding.accessSourceId, subscription: binding.subscription! };
  const count = f.createRuntime.mock.calls.length;
  for (const forged of [
    { ...resolved, subscription: { ...resolved.subscription, peerId: randomUUID() } },
    { ...resolved, subscription: { ...resolved.subscription, accountId: "different" } },
    { ...resolved, route: { ...resolved.route, contextWindow: 100000 } },
    { ...resolved, route: { ...resolved.route, api: "openai-completions" as const } },
  ]) await expect(f.admission.admit({ ownerId: OWNER, chatId: binding.chatId, runId: binding.runId, resolved: forged })).rejects.toThrow();
  expect(f.createRuntime).toHaveBeenCalledTimes(count); f.noFallback();
});
