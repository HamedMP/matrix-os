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

function setup(overrides: { createRuntime?: ReturnType<typeof vi.fn>; available?: boolean } = {}) {
  const client = {
    createRuntime: overrides.createRuntime ?? vi.fn(async () => ({ runtimeHandle: RUNTIME, executionGeneration: "5", state: "running" as const })),
    stopRuntime: vi.fn(async () => ({ runtimeHandle: RUNTIME, executionGeneration: "5", state: "stopped" as const })),
  };
  const registry = new BotRuntimeRegistry();
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
  return { admission, client, registry };
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
});
