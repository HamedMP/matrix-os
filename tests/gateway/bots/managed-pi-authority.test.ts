import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { createBotStateDatabase, OWNER, OTHER_OWNER, BOT } from "./bot-state-support.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { managedPiChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { createManagedPiAdmission } from "../../../packages/gateway/src/chat/managed-pi-admission.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { BotRuntimeRegistry, BotRuntimeRegistryError } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { BotAdmissionError } from "../../../packages/gateway/src/bots/admission.js";
import { resolveManagedPiRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import { managedPiWorkspace } from "../../../packages/gateway/src/chat/managed-pi-workspace.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import type { ResolvedChatExecutionRoot } from "../../../packages/gateway/src/chat/execution-root.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function setup(permissionMode = "full_access", supervisedBrowser = false) {
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  const home = await mkdtemp(join(tmpdir(), "matrix-pi-authority-")); cleanup.push(() => rm(home, { force: true, recursive: true }));
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const snapshot = makeAiProviderSnapshot(); const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  let end: () => void = () => undefined; const hold = new Promise<void>((resolve) => { end = resolve; });
  const catalog = { getCatalog: async () => ({ revision: "test", drivers: [{ kind: "matrix_pi" as const, displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" as const }],
    instances: managedPiChatInstances(snapshot).map((instance) => ({ ...instance, catalogRevision: "test" })) }) };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters: new CanonicalChatProviderRegistry([{
    driverKind: "matrix_pi", stateSchemaVersion: 1, parseState: (value) => value, serializeState: (value) => value,
    async *start() { await hold; yield { type: "run.completed", outcome: "completed" }; },
  }]) });
  cleanup.push(async () => { end(); await orchestrator.drain(); await orchestrator.close(); });
  const owner = { type: "personal" as const, ownerId: OWNER };
  await repository.create(owner, { id: "chat_authority", clientRequestId: "req_authority", title: "Chat" });
  const result = await orchestrator.admitTurn({ userId: OWNER, source: "jwt" }, owner, "chat_authority", {
    clientRequestId: "req_authority_turn", baseRevision: 0, selection, interactionMode: "default", permissionMode,
    parts: [{ type: "text", text: "Hello" }],
  });
  const registry = new BotRuntimeRegistry();
  const createRuntime = vi.fn(async (): Promise<Awaited<ReturnType<ScopeRuntimeHost["client"]["createRuntime"]>>> => ({
    runtimeHandle: `runtime_${"c".repeat(32)}`, executionGeneration: "2", state: "running",
  }));
  const stopRuntime = vi.fn(async () => undefined);
  const renewRuntime = vi.fn(async () => undefined);
  const host = { available: true, client: { createRuntime, renewRuntime, stopRuntime } } as unknown as ScopeRuntimeHost;
  const roots = { resolve: vi.fn(async (): Promise<ResolvedChatExecutionRoot> => { throw new Error("Unexpected project" ); }) };
  const admission = createManagedPiAdmission({ db, homePath: home, host, registry, supervisedBrowser, toolCapabilities: ["browser.action", "mcp.call"], roots });
  const input = { ownerId: OWNER, chatId: "chat_authority", runId: result.run.id, resolved: resolveManagedPiRoute(snapshot, selection) };
  return { db, admission, registry, input, createRuntime, renewRuntime, stopRuntime, roots, home };
}

it("requires exact private owner/chat/run identity and refuses live bot or wrong model authority", async () => {
  const { db, admission, input, createRuntime } = await setup();
  for (const forged of [{ ...input, ownerId: OTHER_OWNER }, { ...input, runId: "run_forged" },
    { ...input, resolved: { ...input.resolved, route: { ...input.resolved.route, modelId: "forged" } } }]) {
    await expect(admission.admit(forged)).rejects.toEqual(new BotAdmissionError("not_found"));
  }
  expect(createRuntime).not.toHaveBeenCalled();
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: input.chatId, now: new Date().toISOString() });
  await expect(admission.admit(input)).rejects.toEqual(new BotAdmissionError("not_found"));
  expect(createRuntime).not.toHaveBeenCalled();
});
it("admits a running supervisor result and registers only the managed run authority", async () => {
  const { admission, input, registry } = await setup();
  const binding = await admission.admit(input);
  expect(registry.lookupRun({ runtimeHandle: binding.runtimeHandle, executionGeneration: "2", runId: input.runId }))
    .toEqual(binding);
  expect(registry.authorize({ runtimeHandle: binding.runtimeHandle, executionGeneration: "2",
    action: "inference.messages", modelId: input.resolved.route.modelId }))
    .toMatchObject({ allowed: true, accessSourceId: input.resolved.accessSourceId });
  expect(binding).not.toHaveProperty("state");
  const unprojected = { ...binding, state: "running" as const };
  expect(() => registry.bind(unprojected)).toThrow(new BotRuntimeRegistryError("invalid_binding"));
  await admission.release(binding.runtimeHandle);
  expect(registry.lookup({ runtimeHandle: binding.runtimeHandle, executionGeneration: "2" })).toBeNull();
});
it("renews only an unchanged live managed binding and refuses cancelled inference", async () => {
  const { admission, input, registry, renewRuntime } = await setup();
  const binding = await admission.admit(input);
  await expect(admission.renew({ ...binding, rootFingerprint: "b".repeat(64) })).rejects.toEqual(new BotAdmissionError("not_found"));
  expect(renewRuntime).not.toHaveBeenCalled();
  await admission.renew(binding);
  expect(renewRuntime).toHaveBeenCalledExactlyOnceWith({ runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration });
  registry.cancelInference(binding);
  await expect(admission.renew(binding)).rejects.toEqual(new BotAdmissionError("not_found"));
  expect(renewRuntime).toHaveBeenCalledTimes(1);
  await admission.release(binding.runtimeHandle);
});
it("stops managed renewal after bounded drain of hung project preflight without late host renewal", async () => {
  const { admission, input, db, roots, registry, renewRuntime, stopRuntime, home } = await setup();
  const ref = { kind: "project" as const, projectId: "project_hung" };
  const resolved: ResolvedChatExecutionRoot = { ref, fingerprint: "a".repeat(64), primaryWorkspaceRoot: home };
  await db.updateTable("chat_runs").set({ execution_root: ref, execution_root_fingerprint: resolved.fingerprint }).where("id", "=", input.runId).execute();
  roots.resolve.mockResolvedValue(resolved);
  const binding = await admission.admit(input);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  roots.resolve.mockClear().mockImplementation(async () => { await gate; return resolved; });
  const onFailure = vi.fn();
  admission.startRenewal(binding, onFailure);
  await vi.waitFor(() => expect(roots.resolve).toHaveBeenCalledOnce());
  await admission.release(binding.runtimeHandle);
  expect(stopRuntime).toHaveBeenCalledOnce();
  expect(registry.lookupRun(binding)).toBeNull();
  finish();
  await Promise.resolve();
  expect(renewRuntime).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled();
});
it("passes an abortable signal to managed host renewal and stops after bounded drain", async () => {
  const { admission, input, registry, renewRuntime, stopRuntime } = await setup();
  const binding = await admission.admit(input);
  let observedSignal: AbortSignal | undefined;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  renewRuntime.mockImplementation(async (request: { signal?: AbortSignal }) => { observedSignal = request.signal; await gate; });
  const onFailure = vi.fn();
  admission.startRenewal(binding, onFailure);
  await vi.waitFor(() => expect(renewRuntime).toHaveBeenCalledOnce());
  expect(observedSignal?.aborted).toBe(false);
  await admission.release(binding.runtimeHandle);
  expect(observedSignal?.aborted).toBe(true);
  expect(stopRuntime).toHaveBeenCalledOnce();
  expect(registry.lookupRun(binding)).toBeNull();
  finish();
  await Promise.resolve();
  expect(onFailure).not.toHaveBeenCalled();
});
it("binds read-only authority and rejects workspace inode changes before any artifact effect", async () => {
  const { admission, input, registry, home, createRuntime } = await setup("supervised");
  const binding = await admission.admit(input);
  expect(binding).toMatchObject({ kind: "managed_chat", capabilities: ["artifact.read"], requestClass: "interactive" });
  expect(binding).not.toHaveProperty("botId"); expect(binding).not.toHaveProperty("taskId");
  expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ profileId: "scope-runtime-managed-pi-v1", sandbox: expect.objectContaining({ network: "broker_only", worktree: expect.objectContaining({ mode: "ro" }) }) }));
  const root = await managedPiWorkspace(home, OWNER, input.chatId);
  expect(await admission.workspace(binding)).toBe(root.path);
  await rename(root.path, `${root.path}.old`); await mkdir(root.path);
  await expect(admission.workspace(binding)).rejects.toEqual(new BotAdmissionError("root_changed"));
  await expect(admission.toolAuthority(binding)).rejects.toEqual(new BotAdmissionError("root_changed"));
  await admission.release(binding.runtimeHandle); expect(registry.size).toBe(0);
});
it("allows only the already bound owner run to resolve pending approval; new admission remains denied", async () => {
  const { admission, input, db } = await setup();
  const binding = await admission.admit(input);
  await db.updateTable("chat_runs").set({ status: "waiting_for_approval" }).where("id", "=", input.runId).execute();
  await expect(admission.toolAuthority(binding)).resolves.toEqual({ permissionMode: "full_access" });
  await expect(admission.admit(input)).rejects.toEqual(new BotAdmissionError("not_found"));
  await expect(admission.toolAuthority({ ...binding, executionGeneration: "3" })).rejects.toEqual(new BotAdmissionError("not_found"));
  await db.updateTable("chat_runs").set({ permission_mode: "supervised" }).where("id", "=", input.runId).execute();
  await expect(admission.toolAuthority(binding)).resolves.toEqual({ permissionMode: "supervised" });
  await admission.release(binding.runtimeHandle);
});

it('fences edited persisted source/options before a previously bound owner run can use tools or artifacts', async () => {
  const { admission, input, db } = await setup();
  const binding = await admission.admit(input);
  await db.updateTable('chat_runs').set({ selection: { instanceId: 'matrix_pi_default', model: input.resolved.route.modelId,
    options: [{ id: 'accountId', value: 'forged' }] } }).where('id', '=', input.runId).execute();
  await expect(admission.toolAuthority(binding)).rejects.toEqual(new BotAdmissionError('not_found'));
  await expect(admission.workspace(binding)).rejects.toEqual(new BotAdmissionError('not_found'));
  await admission.release(binding.runtimeHandle);
});

it.each([false, true])("projects supervised browser capability only with wired authority: %s", async enabled => {
 const { admission, input } = await setup("supervised", enabled); const binding = await admission.admit(input);
 expect(binding.capabilities.includes("browser.action")).toBe(enabled);
 expect(binding.capabilities).not.toContain("mcp.call");
 await admission.release(binding.runtimeHandle);
});
