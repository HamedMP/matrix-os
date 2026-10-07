import { describe, expect, it, vi } from "vitest";
import {
  SCOPE_RUNTIME_BOT_PROFILE,
  SCOPE_RUNTIME_PROFILE,
  createScopeRuntimeController,
  type ScopeRuntimeLauncher,
} from "../../packages/scope-runtime/src/supervisor.js";
import type { ScopeRuntimeSandboxManifest } from "../../packages/scope-runtime/src/protocol.js";

const REQUEST_ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const SCOPE_HANDLE = "scope_11111111111111111111111111111111";
const RUNTIME_HANDLE = "runtime_22222222222222222222222222222222";
const BOT_ADAPTER = { adapterId: "matrix-bot", harnessVersion: "1.0.0", workloads: ["bot_agent" as const] };
const manifest: ScopeRuntimeSandboxManifest = {
  version: 1,
  scopeHandle: SCOPE_HANDLE,
  actorId: "bot_abcdef12",
  worktree: { hostPath: "/home/matrix/home/bots/bot_abcdef12", mode: "rw", fingerprint: "a".repeat(64) },
  network: "broker_only",
};

function launcher(overrides: Partial<ScopeRuntimeLauncher> = {}): ScopeRuntimeLauncher {
  return {
    supportedAdapters: vi.fn(async (profileId?: string) =>
      profileId === SCOPE_RUNTIME_BOT_PROFILE.profileId ? [BOT_ADAPTER]
        : profileId === SCOPE_RUNTIME_PROFILE.profileId ? SCOPE_RUNTIME_PROFILE.adapters : []),
    list: vi.fn(async () => []),
    start: vi.fn(async () => undefined),
    runChat: vi.fn(async () => ({ text: "chat" })),
    runBot: vi.fn(async () => ({ version: 1 as const, ok: true as const, reply: { acknowledged: true } })),
    stop: vi.fn(async () => undefined),
    ...overrides,
  };
}

const createBot = {
  version: 1 as const,
  type: "runtime.create" as const,
  requestId: REQUEST_ID,
  scopeHandle: SCOPE_HANDLE,
  profileId: "scope-runtime-bot-v1",
  workload: "bot_agent" as const,
  adapterId: "matrix-bot",
  harnessVersion: "1.0.0",
  sandbox: manifest,
};

const botCommand = (command: Record<string, unknown>, generation = "4") => ({
  version: 1 as const,
  type: "runtime.bot" as const,
  requestId: REQUEST_ID,
  runtimeHandle: RUNTIME_HANDLE,
  executionGeneration: generation,
  command: { version: 1, runId: "run_one", ...command } as never,
});

describe("scope runtime supervisor bot profile", () => {
  it("advertises both profiles when the host can launch bots, and only Chat otherwise", async () => {
    const both = await createScopeRuntimeController({ launcher: launcher(), executionGeneration: "4" });
    const advertised = await both.handle({ version: 1, type: "capability.get", requestId: REQUEST_ID });
    expect(advertised).toMatchObject({
      ok: true,
      profile: { profileId: "scope-runtime-chat-v1" },
      profiles: [
        { profileId: "scope-runtime-chat-v1", adapters: SCOPE_RUNTIME_PROFILE.adapters },
        {
          profileId: "scope-runtime-bot-v1",
          profileDigest: SCOPE_RUNTIME_BOT_PROFILE.profileDigest,
          adapters: [BOT_ADAPTER],
          sandbox: { workloads: ["bot_agent"] },
          executionGeneration: "4",
        },
      ],
    });

    const chatOnly = await createScopeRuntimeController({
      launcher: launcher({ supportedAdapters: vi.fn(async (profileId?: string) =>
        profileId === SCOPE_RUNTIME_PROFILE.profileId ? SCOPE_RUNTIME_PROFILE.adapters : []) }),
      executionGeneration: "4",
    });
    const response = await chatOnly.handle({ version: 1, type: "capability.get", requestId: REQUEST_ID });
    expect(response).toMatchObject({ ok: true, profiles: [{ profileId: "scope-runtime-chat-v1" }] });
    await expect(chatOnly.handle(createBot)).resolves.toMatchObject({ ok: false, error: "profile_unavailable" });
  });

  it("matches adapters per profile and always sandboxes a bot", async () => {
    const native = launcher();
    const controller = await createScopeRuntimeController({
      launcher: native, executionGeneration: "4", createRuntimeHandle: () => RUNTIME_HANDLE,
    });
    await expect(controller.handle({ ...createBot, profileId: "scope-runtime-chat-v1" }))
      .resolves.toMatchObject({ ok: false, error: "adapter_unavailable" });
    await expect(controller.handle({ ...createBot, adapterId: "claude-code", harnessVersion: "2.1.240" }))
      .resolves.toMatchObject({ ok: false, error: "adapter_unavailable" });
    await expect(controller.handle({ ...createBot, harnessVersion: "0.87.0" }))
      .resolves.toMatchObject({ ok: false, error: "adapter_unavailable" });
    const { sandbox: _sandbox, ...unsandboxed } = createBot;
    await expect(controller.handle(unsandboxed)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    await expect(controller.handle({ ...createBot, sandbox: { ...manifest, scopeHandle: `scope_${"2".repeat(32)}` } }))
      .resolves.toMatchObject({ ok: false, error: "invalid_request" });
    expect(native.start).not.toHaveBeenCalled();

    await expect(controller.handle(createBot)).resolves.toMatchObject({ ok: true, runtimeHandle: RUNTIME_HANDLE });
    expect(native.start).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "scope-runtime-bot-v1", workload: "bot_agent", adapterId: "matrix-bot", sandbox: manifest,
    }));
  });

  it("relays bot commands only to bot runtimes of the current generation", async () => {
    const native = launcher({
      list: vi.fn(async () => [
        { runtimeHandle: RUNTIME_HANDLE, executionGeneration: "4", profileId: "scope-runtime-bot-v1" },
        { runtimeHandle: `runtime_${"3".repeat(32)}`, executionGeneration: "4" },
      ]),
    });
    const controller = await createScopeRuntimeController({ launcher: native, executionGeneration: "4" });

    await expect(controller.handle(botCommand({ kind: "bot.cancel" }))).resolves.toEqual({
      version: 1, type: "runtime.bot.result", requestId: REQUEST_ID, ok: true,
      runtimeHandle: RUNTIME_HANDLE, executionGeneration: "4", reply: { acknowledged: true },
    });
    expect(native.runBot).toHaveBeenCalledWith({
      runtimeHandle: RUNTIME_HANDLE, executionGeneration: "4", command: { version: 1, kind: "bot.cancel", runId: "run_one" },
    });
    await expect(controller.handle(botCommand({ kind: "bot.cancel" }, "3")))
      .resolves.toMatchObject({ ok: false, error: "generation_mismatch" });
    await expect(controller.handle({ ...botCommand({ kind: "bot.cancel" }), runtimeHandle: `runtime_${"3".repeat(32)}` }))
      .resolves.toMatchObject({ ok: false, error: "runtime_not_found" });
    // A Chat request cannot reach a bot runtime either.
    await expect(controller.handle({
      version: 1, type: "runtime.chat", requestId: REQUEST_ID, runtimeHandle: RUNTIME_HANDLE,
      executionGeneration: "4", model: "claude-opus-4-6", prompt: "hi",
    })).resolves.toMatchObject({ ok: false, error: "runtime_not_found" });
  });

  it("maps worker refusals and failures to allowlisted errors", async () => {
    const replies = [
      { version: 1 as const, ok: false as const, error: "busy" as const },
      { version: 1 as const, ok: false as const, error: "invalid_command" as const },
      { version: 1 as const, ok: false as const, error: "unavailable" as const },
    ];
    const native = launcher({
      list: vi.fn(async () => [{ runtimeHandle: RUNTIME_HANDLE, executionGeneration: "4", profileId: "scope-runtime-bot-v1" }]),
      runBot: vi.fn(async () => {
        const reply = replies.shift();
        if (!reply) throw new Error("socket path /var/lib/secret");
        return reply;
      }),
    });
    const controller = await createScopeRuntimeController({ launcher: native, executionGeneration: "4" });
    const run = () => controller.handle(botCommand({ kind: "bot.run" }));
    await expect(run()).resolves.toMatchObject({ ok: false, error: "busy" });
    await expect(run()).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    await expect(run()).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
    const failed = await run();
    expect(failed).toMatchObject({ ok: false, error: "runtime_unavailable" });
    expect(JSON.stringify(failed)).not.toContain("secret");
  });

  it("frees capacity held by runtimes whose units already exited", async () => {
    let running = new Set([RUNTIME_HANDLE]);
    let next = 0;
    const native = launcher({ active: vi.fn(async () => running) });
    const controller = await createScopeRuntimeController({
      launcher: native,
      executionGeneration: "4",
      maxRuntimes: 1,
      createRuntimeHandle: () => (next++ === 0 ? RUNTIME_HANDLE : `runtime_${"4".repeat(32)}`),
    });
    await expect(controller.handle(createBot)).resolves.toMatchObject({ ok: true });
    // Still running: the slot stays taken.
    await expect(controller.handle(createBot)).resolves.toMatchObject({ ok: false, error: "capacity_exceeded" });
    // The unit hit RuntimeMaxSec: the stale entry is dropped and the slot is reused.
    running = new Set();
    await expect(controller.handle(createBot)).resolves.toMatchObject({ ok: true, runtimeHandle: `runtime_${"4".repeat(32)}` });
    expect(controller.size()).toBe(1);
  });

  it("keeps a runtime whose create finished while the liveness snapshot was taken", async () => {
    const stale = `runtime_${"5".repeat(32)}`;
    const fresh = `runtime_${"6".repeat(32)}`;
    let releaseSnapshot!: (running: ReadonlySet<string>) => void;
    const native = launcher({
      list: vi.fn(async () => [{ runtimeHandle: stale, executionGeneration: "4", profileId: "scope-runtime-bot-v1" }]),
      active: vi.fn(() => new Promise<ReadonlySet<string>>((resolve) => { releaseSnapshot = resolve; })),
    });
    const controller = await createScopeRuntimeController({
      launcher: native,
      executionGeneration: "4",
      maxRuntimes: 2,
      createRuntimeHandle: () => fresh,
    });
    // The slot is free, so this create does not prune; it starts while a relay failure prunes below.
    const failing = launcher({ runBot: vi.fn(async () => { throw new Error("worker gone"); }) }).runBot!;
    native.runBot = failing;
    const relay = controller.handle({ ...botCommand({ kind: "bot.cancel" }), runtimeHandle: stale });
    await vi.waitFor(() => expect(native.active).toHaveBeenCalled());
    await expect(controller.handle(createBot)).resolves.toMatchObject({ ok: true, runtimeHandle: fresh });
    // The snapshot predates the new unit, so it lists neither handle.
    releaseSnapshot(new Set());
    await expect(relay).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
    expect(controller.size()).toBe(1);
    native.runBot = vi.fn(async () => ({ version: 1 as const, ok: true as const, reply: { acknowledged: true } }));
    await expect(controller.handle({ ...botCommand({ kind: "bot.cancel" }), runtimeHandle: fresh }))
      .resolves.toMatchObject({ ok: true, runtimeHandle: fresh });
  });
});
