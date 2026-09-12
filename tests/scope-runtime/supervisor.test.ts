import { describe, expect, it, vi } from "vitest";
import {
  SCOPE_RUNTIME_PROFILE,
  createScopeRuntimeController,
  type ScopeRuntimeLauncher,
} from "../../packages/scope-runtime/src/supervisor.js";

const REQUEST_ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const SCOPE_HANDLE = "scope_11111111111111111111111111111111";
const RUNTIME_HANDLE = "runtime_22222222222222222222222222222222";

function launcher(overrides: Partial<ScopeRuntimeLauncher> = {}): ScopeRuntimeLauncher {
  return {
    list: vi.fn(async () => []),
    start: vi.fn(async () => undefined),
    runChat: vi.fn(async () => ({ text: "Scoped response" })),
    stop: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("scope runtime supervisor", () => {
  it("advertises only the measured non-root Chat profile", async () => {
    const controller = await createScopeRuntimeController({
      launcher: launcher(),
      executionGeneration: "9",
      createRuntimeHandle: () => RUNTIME_HANDLE,
    });

    await expect(controller.handle({
      version: 1,
      type: "capability.get",
      requestId: REQUEST_ID,
    })).resolves.toEqual({
      version: 1,
      type: "capability.result",
      requestId: REQUEST_ID,
      ok: true,
      supervisorVersion: "1.0.0",
      profile: { ...SCOPE_RUNTIME_PROFILE, executionGeneration: "9" },
    });
    expect(SCOPE_RUNTIME_PROFILE.identity).toEqual({
      mode: "dynamic",
      uidMin: 61_184,
      uidMax: 65_519,
    });
    expect(SCOPE_RUNTIME_PROFILE.profileDigest)
      .toBe("6650e74684fd322251882f65c36e1226149087dac346eee8a43da426a57fad8e");
    expect(SCOPE_RUNTIME_PROFILE.adapters).toEqual([{
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
      workloads: ["chat_ai"],
    }]);
  });

  it("maps an opaque create request to the fixed launcher and stops by handle", async () => {
    const native = launcher();
    const controller = await createScopeRuntimeController({
      launcher: native,
      executionGeneration: "10",
      createRuntimeHandle: () => RUNTIME_HANDLE,
    });

    await expect(controller.handle({
      version: 1,
      type: "runtime.create",
      requestId: REQUEST_ID,
      scopeHandle: SCOPE_HANDLE,
      profileId: SCOPE_RUNTIME_PROFILE.profileId,
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    })).resolves.toMatchObject({ ok: true, runtimeHandle: RUNTIME_HANDLE, state: "running" });
    expect(native.start).toHaveBeenCalledWith({
      runtimeHandle: RUNTIME_HANDLE,
      scopeHandle: SCOPE_HANDLE,
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
      executionGeneration: "10",
    });

    await expect(controller.handle({
      version: 1,
      type: "runtime.chat",
      requestId: REQUEST_ID,
      runtimeHandle: RUNTIME_HANDLE,
      executionGeneration: "10",
      model: "claude-opus-4-6",
      prompt: "Summarize the visible shared discussion.",
    })).resolves.toMatchObject({ ok: true, text: "Scoped response" });
    expect(native.runChat).toHaveBeenCalledWith({
      runtimeHandle: RUNTIME_HANDLE,
      executionGeneration: "10",
      model: "claude-opus-4-6",
      prompt: "Summarize the visible shared discussion.",
    });

    await expect(controller.handle({
      version: 1,
      type: "runtime.stop",
      requestId: REQUEST_ID,
      runtimeHandle: RUNTIME_HANDLE,
    })).resolves.toMatchObject({ ok: true, state: "stopped" });
    expect(native.stop).toHaveBeenCalledWith(RUNTIME_HANDLE);
  });

  it("preserves the attested launch generation for a reconciled runtime", async () => {
    const native = launcher({
      list: vi.fn(async () => [{ runtimeHandle: RUNTIME_HANDLE, executionGeneration: "7" }]),
    });
    const controller = await createScopeRuntimeController({
      launcher: native,
      executionGeneration: "13",
    });

    await expect(controller.handle({
      version: 1,
      type: "runtime.stop",
      requestId: REQUEST_ID,
      runtimeHandle: RUNTIME_HANDLE,
    })).resolves.toMatchObject({
      ok: true,
      state: "stopped",
      executionGeneration: "7",
    });
  });

  it("fails closed for unproven profiles, harnesses, workloads, and launcher failures", async () => {
    const native = launcher({ start: vi.fn(async () => { throw new Error("host detail"); }) });
    const controller = await createScopeRuntimeController({
      launcher: native,
      executionGeneration: "11",
      createRuntimeHandle: () => RUNTIME_HANDLE,
    });
    const base = {
      version: 1 as const,
      type: "runtime.create" as const,
      requestId: REQUEST_ID,
      scopeHandle: SCOPE_HANDLE,
      profileId: SCOPE_RUNTIME_PROFILE.profileId,
      workload: "chat_ai" as const,
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    };

    await expect(controller.handle({ ...base, profileId: "scope-runtime-proof-v2" }))
      .resolves.toMatchObject({ ok: false, error: "profile_unavailable" });
    await expect(controller.handle({ ...base, harnessVersion: "2.1.241" }))
      .resolves.toMatchObject({ ok: false, error: "adapter_unavailable" });
    await expect(controller.handle({ ...base, workload: "terminal" }))
      .resolves.toMatchObject({ ok: false, error: "adapter_unavailable" });
    await expect(controller.handle(base))
      .resolves.toEqual(expect.objectContaining({ ok: false, error: "runtime_unavailable" }));
    expect(controller.size()).toBe(0);
  });

  it("reserves capacity across concurrent creates and drains owned runtimes on shutdown", async () => {
    let releaseStart: (() => void) | undefined;
    const startBarrier = new Promise<void>((resolve) => { releaseStart = resolve; });
    const native = launcher({ start: vi.fn(async () => startBarrier) });
    let sequence = 1;
    const controller = await createScopeRuntimeController({
      launcher: native,
      executionGeneration: "12",
      maxRuntimes: 1,
      createRuntimeHandle: () => `runtime_${String(sequence++).padStart(32, "0")}`,
    });
    const create = (requestId: string) => controller.handle({
      version: 1,
      type: "runtime.create",
      requestId,
      scopeHandle: SCOPE_HANDLE,
      profileId: SCOPE_RUNTIME_PROFILE.profileId,
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    });

    const first = create(REQUEST_ID);
    await expect(create("018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2"))
      .resolves.toMatchObject({ ok: false, error: "capacity_exceeded" });
    releaseStart?.();
    await expect(first).resolves.toMatchObject({ ok: true });

    await controller.close();
    expect(native.stop).toHaveBeenCalledWith("runtime_00000000000000000000000000000001");
    await expect(create("018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d3"))
      .resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
  });
});
