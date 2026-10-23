import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BotAdmissionError, createPrivateBotAdmission, privateBotScopeHandle, type PrivateBotRunRequest } from "../../../packages/gateway/src/bots/admission.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { BotRuntimeRegistry, BotRuntimeRegistryError } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotWorkspace } from "../../../packages/gateway/src/chat/bot-workspace-root.js";
import { createChatExecutionRootResolver } from "../../../packages/gateway/src/chat/execution-root.js";
import { SharedAiRuntimeRegistry } from "../../../packages/gateway/src/collaboration/shared-ai-runtime-registry.js";
import { ScopeRuntimeClientError } from "../../../packages/gateway/src/collaboration/scope-runtime-client.js";
import { BOT, NOW, OTHER_OWNER, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const RUNTIME = `runtime_${"d".repeat(32)}`;
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let homePath: string;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  homePath = await mkdtemp(join(tmpdir(), "bot-admission-home-"));
  await insertChat(db, "chat_direct1");
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
  await createBotWorkspace({ homePath, botId: BOT });
});
afterEach(async () => {
  await destroy();
  await rm(homePath, { recursive: true, force: true });
});

function setup(overrides: { createRuntime?: ReturnType<typeof vi.fn>; renewRuntime?: ReturnType<typeof vi.fn>; available?: boolean; registry?: BotRuntimeRegistry } = {}) {
  const client = {
    createRuntime: overrides.createRuntime ?? vi.fn(async () => ({ runtimeHandle: RUNTIME, executionGeneration: "5", state: "running" as const })),
    renewRuntime: overrides.renewRuntime ?? vi.fn(async () => ({ runtimeHandle: RUNTIME, executionGeneration: "5", state: "running" as const })),
    stopRuntime: vi.fn(async () => ({ runtimeHandle: RUNTIME, executionGeneration: "5", state: "stopped" as const })),
  };
  const registry = overrides.registry ?? new BotRuntimeRegistry();
  const roots = createChatExecutionRootResolver({
    homePath,
    projects: { getProjectById: vi.fn(), resolveProjectWorkingDirectory: vi.fn() },
    worktrees: { getWorktree: vi.fn() },
  });
  const admission = createPrivateBotAdmission({
    db,
    host: { available: overrides.available ?? true, client: client as never },
    roots,
    registry,
  });
  return { admission, client, registry, roots };
}

const request: PrivateBotRunRequest = {
  ownerId: OWNER,
  botId: BOT,
  chatId: "chat_direct1",
  taskId: "task_0123456789abcdef",
  runId: "run_private1",
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 4_096 },
  accessSourceId: "matrix_included",
  capabilities: ["artifact.write", "artifact.read"],
  requestClass: "interactive",
};

describe("private bot admission", () => {
  it("derives the private handle from owner and bot, mounts only the bot workspace, and binds the run", async () => {
    const { admission, client, registry } = setup();
    const admitted = await admission.admit(request);
    const handle = `scope_${createHash("sha256").update(`bot-private:${OWNER}:${BOT}`).digest("hex").slice(0, 32)}`;
    expect(privateBotScopeHandle(OWNER, BOT)).toBe(handle);
    expect(client.createRuntime).toHaveBeenCalledWith({
      scopeHandle: handle,
      profileId: "scope-runtime-bot-v1",
      workload: "bot_agent",
      adapterId: "matrix-bot",
      harnessVersion: "1.0.0",
      sandbox: {
        version: 1,
        scopeHandle: handle,
        actorId: BOT,
        worktree: { hostPath: join(homePath, "bots", BOT), mode: "rw", fingerprint: admitted.rootFingerprint },
        network: "broker_only",
      },
    });
    expect(registry.lookupRun({ runtimeHandle: RUNTIME, executionGeneration: "5", runId: "run_private1" }))
      .toMatchObject({ ownerId: OWNER, botId: BOT, taskId: "task_0123456789abcdef", rootFingerprint: admitted.rootFingerprint });
  });

  it("admits only the owner of the bot's live direct chat, with no collaboration scope", async () => {
    const { admission, client } = setup();
    await expect(admission.admit({ ...request, ownerId: OTHER_OWNER })).rejects.toEqual(new BotAdmissionError("not_found"));
    await expect(admission.admit({ ...request, chatId: "chat_other9" })).rejects.toEqual(new BotAdmissionError("not_found"));
    await createBotBindingsRepository(db).remove({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
    await expect(admission.admit(request)).rejects.toEqual(new BotAdmissionError("not_found"));
    expect(client.createRuntime).not.toHaveBeenCalled();
  });

  it("verifies a personal active nonshared direct chat before exposing owner identity", async () => {
    const { admission, client } = setup();
    expect(await admission.ownsDirectChat(request)).toBe(true);
    await db.updateTable("chats").set({ collaboration: JSON.stringify({ sharedScopeId: "shared_test" }) }).where("id", "=", request.chatId).execute();
    expect(await admission.ownsDirectChat(request)).toBe(false);
    await expect(admission.admit(request)).rejects.toEqual(new BotAdmissionError("not_found"));
    await db.updateTable("chats").set({ collaboration: null, lifecycle: "archived" }).where("id", "=", request.chatId).execute();
    expect(await admission.ownsDirectChat(request)).toBe(false);
    expect(client.createRuntime).not.toHaveBeenCalled();
  });

  it.each(["shared", "archived", "removed"])("does not publish a runtime when its direct chat becomes %s during provisioning", async changed => {
    let resume!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve; });
    const createRuntime = vi.fn(async () => {
      await pending;
      return { runtimeHandle: RUNTIME, executionGeneration: "5", state: "running" as const };
    });
    const { admission, client, registry } = setup({ createRuntime });
    const outcome = admission.admit(request).then(value => ({ value }), error => ({ error }));
    try {
      await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());
      if (changed === "removed") await createBotBindingsRepository(db).remove({ ownerId: OWNER, botId: BOT, chatId: request.chatId, now: NOW });
      else await db.updateTable("chats").set(changed === "shared"
        ? { collaboration: JSON.stringify({ sharedScopeId: "shared_race" }) }
        : { lifecycle: "archived" }).where("id", "=", request.chatId).execute();
    } finally { resume(); }
    expect(await outcome).toEqual({ error: new BotAdmissionError("not_found") });
    expect(registry.lookup({ runtimeHandle: RUNTIME, executionGeneration: "5" })).toBeNull();
    expect(client.stopRuntime).toHaveBeenCalledWith({ runtimeHandle: RUNTIME });
  });

  it("blocks on a missing or drifted workspace and when the host is down", async () => {
    const { admission } = setup();
    await expect(admission.admit({ ...request, expectedRootFingerprint: "0".repeat(64) })).rejects.toEqual(new BotAdmissionError("root_changed"));
    await rm(join(homePath, "bots", BOT), { recursive: true });
    await expect(admission.admit(request)).rejects.toEqual(new BotAdmissionError("invalid_root"));
    await expect(setup({ available: false }).admission.admit(request)).rejects.toEqual(new BotAdmissionError("unavailable"));
    const refused = setup({ createRuntime: vi.fn(async () => { throw new ScopeRuntimeClientError("runtime_unavailable"); }) });
    await createBotWorkspace({ homePath, botId: BOT });
    await expect(refused.admission.admit(request)).rejects.toEqual(new BotAdmissionError("unavailable"));
  });

  it("stops the runtime when the registry is full, and release unbinds before stopping", async () => {
    const { admission, client, registry } = setup();
    vi.spyOn(registry, "bind").mockImplementation(() => { throw new BotRuntimeRegistryError("capacity_exceeded"); });
    await expect(admission.admit(request)).rejects.toEqual(new BotAdmissionError("capacity_exceeded"));
    expect(client.stopRuntime).toHaveBeenCalledWith({ runtimeHandle: RUNTIME });
    expect(registry.lookup({ runtimeHandle: RUNTIME, executionGeneration: "5" })).toBeNull();
  });

  it("keeps private handles out of the shared registry's reach", async () => {
    const { admission } = setup();
    await admission.admit(request);
    const shared = new SharedAiRuntimeRegistry();
    expect(shared.lookup({ runtimeHandle: RUNTIME, executionGeneration: "5" })).toBeNull();
    expect(shared.authorize({ runtimeHandle: RUNTIME, executionGeneration: "5", action: "inference.messages" })).toEqual({ allowed: false });
  });

  it("renews only the same live run and preserves its inference authority", async () => {
    const { admission, client, registry } = setup();
    const admitted = await admission.admit(request);
    const current = registry.lookupRun({ ...admitted, runId: request.runId });
    if (!current || "kind" in current) throw new Error("missing private bot binding");
    const signal = registry.inferenceSignal(current);
    await admission.renew(current);
    expect(client.renewRuntime).toHaveBeenCalledExactlyOnceWith({ runtimeHandle: RUNTIME, executionGeneration: "5" });
    expect(registry.inferenceSignal(current)).toBe(signal);
    expect(registry.lookupRun(current)).toEqual(current);
  });

  it("refuses renew after direct-chat removal, root drift, cancellation or release", async () => {
    const { admission, client, registry, roots } = setup();
    const admitted = await admission.admit(request);
    const current = registry.lookupRun({ ...admitted, runId: request.runId });
    if (!current || "kind" in current) throw new Error("missing private bot binding");
    await createBotBindingsRepository(db).remove({ ownerId: OWNER, botId: BOT, chatId: request.chatId, now: NOW });
    await expect(admission.renew(current)).rejects.toEqual(new BotAdmissionError("not_found"));
    expect(client.renewRuntime).not.toHaveBeenCalled();

    await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: request.chatId, now: NOW });
    const resolved = await roots.resolve({ type: "personal", ownerId: OWNER }, { kind: "bot_workspace", botId: BOT });
    vi.spyOn(roots, "resolve").mockResolvedValue({ ...resolved, fingerprint: "0".repeat(64) });
    await expect(admission.renew(current)).rejects.toEqual(new BotAdmissionError("root_changed"));
    expect(client.renewRuntime).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    registry.cancelInference(current);
    await expect(admission.renew(current)).rejects.toEqual(new BotAdmissionError("not_found"));
    expect(client.renewRuntime).not.toHaveBeenCalled();
    await admission.release(current.runtimeHandle);
    await expect(admission.renew(current)).rejects.toEqual(new BotAdmissionError("not_found"));
  });

  it("does not revive a binding released during host renewal", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const renewRuntime = vi.fn(async () => { await gate; return { runtimeHandle: RUNTIME, executionGeneration: "5", state: "running" as const }; });
    const { admission, client, registry } = setup({ renewRuntime });
    const admitted = await admission.admit(request);
    const current = registry.lookupRun({ ...admitted, runId: request.runId });
    if (!current || "kind" in current) throw new Error("missing private bot binding");
    const renewal = admission.renew(current);
    await vi.waitFor(() => expect(renewRuntime).toHaveBeenCalledOnce());
    registry.release(current.runtimeHandle);
    finish();
    await expect(renewal).rejects.toEqual(new BotAdmissionError("not_found"));
    expect(registry.lookupRun(current)).toBeNull();
    expect(client.stopRuntime).not.toHaveBeenCalled();
  });

  it("refuses renewal if the workspace changes while the host call is pending", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const renewRuntime = vi.fn(async () => { await gate; return { runtimeHandle: RUNTIME, executionGeneration: "5", state: "running" as const }; });
    const { admission, registry, roots } = setup({ renewRuntime });
    const admitted = await admission.admit(request);
    const current = registry.lookupRun({ ...admitted, runId: request.runId });
    if (!current || "kind" in current) throw new Error("missing private bot binding");
    const renewal = admission.renew(current);
    await vi.waitFor(() => expect(renewRuntime).toHaveBeenCalledOnce());
    const resolved = await roots.resolve({ type: "personal", ownerId: OWNER }, { kind: "bot_workspace", botId: BOT });
    vi.spyOn(roots, "resolve").mockResolvedValue({ ...resolved, fingerprint: "0".repeat(64) });
    finish();
    await expect(renewal).rejects.toEqual(new BotAdmissionError("root_changed"));
  });

  it("maps host renewal failure to an unavailable admission", async () => {
    const { admission, registry } = setup({ renewRuntime: vi.fn(async () => { throw new ScopeRuntimeClientError("runtime_unavailable"); }) });
    const admitted = await admission.admit(request);
    const current = registry.lookupRun({ ...admitted, runId: request.runId });
    if (!current || "kind" in current) throw new Error("missing private bot binding");
    await expect(admission.renew(current)).rejects.toEqual(new BotAdmissionError("unavailable"));
  });

  it("stops and awaits an in-flight heartbeat before stopping the host", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const renewRuntime = vi.fn(async () => { await gate; return { runtimeHandle: RUNTIME, executionGeneration: "5", state: "running" as const }; });
    const { admission, client, registry } = setup({ renewRuntime });
    const admitted = await admission.admit(request);
    const current = registry.lookupRun({ ...admitted, runId: request.runId });
    if (!current || "kind" in current) throw new Error("missing private bot binding");
    const onFailure = vi.fn();
    admission.startRenewal(current, onFailure);
    await vi.waitFor(() => expect(renewRuntime).toHaveBeenCalledOnce());
    const releasing = admission.release(current.runtimeHandle);
    expect(client.stopRuntime).not.toHaveBeenCalled();
    finish();
    await releasing;
    expect(client.stopRuntime).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("stops after bounded drain when root preflight hangs and never renews the host late", async () => {
    const { admission, client, registry, roots } = setup();
    const admitted = await admission.admit(request);
    const current = registry.lookupRun({ ...admitted, runId: request.runId });
    if (!current || "kind" in current) throw new Error("missing private bot binding");
    const resolved = await roots.resolve({ type: "personal", ownerId: OWNER }, { kind: "bot_workspace", botId: BOT });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const resolve = vi.spyOn(roots, "resolve").mockImplementation(async () => { await gate; return resolved; });
    const onFailure = vi.fn();
    admission.startRenewal(current, onFailure);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    await admission.release(current.runtimeHandle);
    expect(client.stopRuntime).toHaveBeenCalledOnce();
    expect(registry.lookupRun(current)).toBeNull();
    finish();
    await Promise.resolve();
    expect(client.renewRuntime).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("stops after bounded drain when host renewal ignores abort and fences its late reply", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const renewRuntime = vi.fn(async () => { await gate; return { runtimeHandle: RUNTIME, executionGeneration: "5", state: "running" as const }; });
    const { admission, client, registry } = setup({ renewRuntime });
    const admitted = await admission.admit(request);
    const current = registry.lookupRun({ ...admitted, runId: request.runId });
    if (!current || "kind" in current) throw new Error("missing private bot binding");
    const onFailure = vi.fn();
    admission.startRenewal(current, onFailure);
    await vi.waitFor(() => expect(renewRuntime).toHaveBeenCalledOnce());
    await admission.release(current.runtimeHandle);
    expect(client.stopRuntime).toHaveBeenCalledOnce();
    expect(registry.lookupRun(current)).toBeNull();
    finish();
    await Promise.resolve();
    expect(registry.lookupRun(current)).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
