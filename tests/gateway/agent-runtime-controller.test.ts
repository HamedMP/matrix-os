import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentRuntimeController,
  type MessagingRuntimeAdapter,
} from "../../packages/gateway/src/agent-config/runtime-controller.js";

const homes: string[] = [];

async function createHome(config: Record<string, unknown> = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "agent-runtime-controller-"));
  homes.push(homePath);
  await mkdir(join(homePath, "system"), { recursive: true });
  await writeFile(join(homePath, "system/config.json"), JSON.stringify(config));
  return homePath;
}

function fakeAdapter(
  id: "hermes" | "openclaw",
  overrides: Partial<MessagingRuntimeAdapter> = {},
): MessagingRuntimeAdapter {
  return {
    id,
    probe: vi.fn(async () => ({
      id,
      displayName: id === "hermes" ? "Hermes" : "OpenClaw",
      installState: "installed",
      health: "healthy",
      selectionState: "available",
      configured: true,
      capabilities: ["provider_catalog", "model_selection"],
    })),
    catalog: vi.fn(async () => []),
    selection: vi.fn(async () => ({
      runtime: id,
      provider: "provider",
      model: "model",
      configured: true,
    })),
    configure: vi.fn(async () => ({
      runtime: id,
      provider: "provider",
      model: "model",
      configured: true,
    })),
    prepare: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    deactivate: vi.fn(async () => {}),
    dashboard: vi.fn(async () => null),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("agent runtime controller", () => {
  it("rejects absent OpenClaw without changing owner config", async () => {
    const homePath = await createHome({ unrelated: { preserved: true } });
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes: fakeAdapter("hermes") },
    });

    await expect(controller.update({ runtime: "openclaw", revision: 0 }))
      .rejects.toMatchObject({ kind: "runtime_unavailable" });
    await expect(readFile(join(homePath, "system/config.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ unrelated: { preserved: true } }));
  });

  it("recovers from a persisted absent runtime by switching to healthy Hermes", async () => {
    const homePath = await createHome({
      agent: { messagingRuntime: "openclaw", revision: 2 },
    });
    const hermes = fakeAdapter("hermes");
    const resumeDelivery = vi.fn(async () => {});
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes },
      resumeDelivery,
    });

    await expect(controller.update({ runtime: "hermes", revision: 2 }))
      .resolves.toMatchObject({ runtime: "hermes", revision: 3 });
    const config = JSON.parse(await readFile(
      join(homePath, "system/config.json"),
      "utf8",
    ));
    expect(config.agent).toMatchObject({
      messagingRuntime: "hermes",
      revision: 3,
    });
    expect(hermes.activate).toHaveBeenCalledOnce();
    expect(resumeDelivery).toHaveBeenCalledWith("hermes", expect.any(AbortSignal));
  });

  it("rejects a stale revision before touching either adapter", async () => {
    const homePath = await createHome({
      agent: { messagingRuntime: "hermes", revision: 3 },
    });
    const hermes = fakeAdapter("hermes");
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes },
    });

    await expect(controller.update({
      provider: "provider",
      messagingModel: "model",
      revision: 2,
    })).rejects.toMatchObject({ kind: "agent_config_conflict" });
    expect(hermes.configure).not.toHaveBeenCalled();
  });

  it("health-gates a switch and rolls service activation back on failure", async () => {
    const homePath = await createHome({
      agent: { messagingRuntime: "hermes", revision: 0 },
    });
    const calls: string[] = [];
    const hermes = fakeAdapter("hermes", {
      deactivate: vi.fn(async () => { calls.push("hermes:deactivate"); }),
      activate: vi.fn(async () => { calls.push("hermes:activate"); }),
    });
    const openclaw = fakeAdapter("openclaw", {
      prepare: vi.fn(async () => { calls.push("openclaw:prepare"); }),
      activate: vi.fn(async () => {
        calls.push("openclaw:activate");
        throw new Error("activation secret canary");
      }),
      deactivate: vi.fn(async () => { calls.push("openclaw:deactivate"); }),
    });
    const pauseDelivery = vi.fn(async () => { calls.push("delivery:pause"); });
    const drainDelivery = vi.fn(async () => { calls.push("delivery:drain"); });
    const resumeDelivery = vi.fn(async (runtime: string) => {
      calls.push(`delivery:resume:${runtime}`);
    });
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes, openclaw },
      pauseDelivery,
      drainDelivery,
      resumeDelivery,
    });

    await expect(controller.update({ runtime: "openclaw", revision: 0 }))
      .rejects.toMatchObject({ kind: "runtime_switch_failed" });
    expect(calls).toEqual([
      "openclaw:prepare",
      "delivery:pause",
      "delivery:drain",
      "hermes:deactivate",
      "openclaw:activate",
      "openclaw:deactivate",
      "hermes:activate",
      "delivery:resume:hermes",
    ]);
    const config = JSON.parse(await readFile(
      join(homePath, "system/config.json"),
      "utf8",
    ));
    expect(config.agent).toEqual({ messagingRuntime: "hermes", revision: 0 });
  });

  it("persists only a healthy switch and preserves unrelated config", async () => {
    const homePath = await createHome({
      unrelated: { preserved: true },
      agent: { messagingRuntime: "hermes", revision: 6 },
    });
    const hermes = fakeAdapter("hermes");
    const openclaw = fakeAdapter("openclaw");
    const resumeDelivery = vi.fn(async () => {});
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes, openclaw },
      resumeDelivery,
    });

    await expect(controller.update({ runtime: "openclaw", revision: 6 }))
      .resolves.toMatchObject({ revision: 7, runtime: "openclaw" });
    const config = JSON.parse(await readFile(
      join(homePath, "system/config.json"),
      "utf8",
    ));
    expect(config.unrelated).toEqual({ preserved: true });
    expect(config.agent).toMatchObject({
      messagingRuntime: "openclaw",
      revision: 7,
    });
    expect(resumeDelivery).toHaveBeenCalledWith("openclaw", expect.any(AbortSignal));
  });

  it("atomically preserves and patches Chat settings in a combined update", async () => {
    const homePath = await createHome({
      kernel: {
        model: "claude-opus-4-6",
        effort: "high",
        anthropicApiKey: "owner-secret",
      },
      agent: { messagingRuntime: "hermes", revision: 2 },
    });
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes: fakeAdapter("hermes") },
    });

    await controller.update({
      model: "claude-haiku-4-5",
      effort: "low",
      provider: "provider",
      messagingModel: "model",
      revision: 2,
    });

    const config = JSON.parse(await readFile(
      join(homePath, "system/config.json"),
      "utf8",
    ));
    expect(config.kernel).toEqual({
      model: "claude-haiku-4-5",
      effort: "low",
      anthropicApiKey: "owner-secret",
    });
    expect(config.agent).toMatchObject({
      messagingRuntime: "hermes",
      revision: 3,
    });
  });

  it("does not query a stopped target selection before prepare and activation", async () => {
    const homePath = await createHome();
    let active = false;
    const openclaw = fakeAdapter("openclaw", {
      prepare: vi.fn(async () => {}),
      activate: vi.fn(async () => { active = true; }),
      selection: vi.fn(async () => {
        if (!active) throw new Error("target gateway is stopped");
        return {
          runtime: "openclaw",
          provider: "provider",
          model: "model",
          configured: true,
        };
      }),
    });
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes: fakeAdapter("hermes"), openclaw },
    });

    await expect(controller.update({ runtime: "openclaw", revision: 0 }))
      .resolves.toMatchObject({ runtime: "openclaw", revision: 1 });
    expect(openclaw.prepare).toHaveBeenCalledBefore(
      openclaw.selection as ReturnType<typeof vi.fn>,
    );
    expect(openclaw.activate).toHaveBeenCalledBefore(
      openclaw.selection as ReturnType<typeof vi.fn>,
    );
  });

  it("restores a changed target selection before deactivating rollback", async () => {
    const homePath = await createHome();
    const calls: string[] = [];
    let active = false;
    const openclaw = fakeAdapter("openclaw", {
      activate: vi.fn(async () => { active = true; calls.push("activate"); }),
      deactivate: vi.fn(async () => { active = false; calls.push("deactivate"); }),
      selection: vi.fn(async () => ({
        runtime: "openclaw",
        provider: "old-provider",
        model: "old-model",
        configured: true,
      })),
      configure: vi.fn(async (input) => {
        if (!active) throw new Error("runtime must be active");
        calls.push(`configure:${input.provider}/${input.model}`);
        return {
          runtime: "openclaw",
          provider: input.provider,
          model: input.model,
          configured: true,
        };
      }),
    });
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes: fakeAdapter("hermes"), openclaw },
      resumeDelivery: vi.fn(async (runtime) => {
        if (runtime === "openclaw") throw new Error("delivery failed");
      }),
    });

    await expect(controller.update({
      runtime: "openclaw",
      provider: "new-provider",
      messagingModel: "new-model",
      revision: 0,
    })).rejects.toMatchObject({ kind: "runtime_switch_failed" });
    expect(calls).toContain("configure:old-provider/old-model");
    expect(calls.indexOf("configure:old-provider/old-model"))
      .toBeLessThan(calls.indexOf("deactivate"));
  });

  it("admits only one concurrent transition and leaves no lock file", async () => {
    const homePath = await createHome();
    let releasePrepare: (() => void) | undefined;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const openclaw = fakeAdapter("openclaw", {
      prepare: vi.fn(async () => prepareGate),
    });
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes: fakeAdapter("hermes"), openclaw },
    });

    const first = controller.update({ runtime: "openclaw", revision: 0 });
    await vi.waitFor(() => expect(openclaw.prepare).toHaveBeenCalledOnce());
    await expect(controller.update({ runtime: "openclaw", revision: 0 }))
      .rejects.toMatchObject({ kind: "agent_config_conflict" });
    releasePrepare?.();
    await expect(first).resolves.toMatchObject({ revision: 1 });
    await expect(readFile(
      join(homePath, "system/agent-runtime/transition.lock"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let reconciliation remove a live transition lock", async () => {
    const homePath = await createHome();
    let releasePrepare: (() => void) | undefined;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const openclaw = fakeAdapter("openclaw", {
      prepare: vi.fn(async () => prepareGate),
    });
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes: fakeAdapter("hermes"), openclaw },
    });
    const update = controller.update({ runtime: "openclaw", revision: 0 });
    await vi.waitFor(() => expect(openclaw.prepare).toHaveBeenCalledOnce());
    const lockPath = join(homePath, "system/agent-runtime/transition.lock");

    await expect(controller.reconcile()).rejects.toMatchObject({
      kind: "agent_config_conflict",
    });
    await expect(lstat(lockPath)).resolves.toMatchObject({});

    releasePrepare?.();
    await expect(update).resolves.toMatchObject({ runtime: "openclaw" });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes legacy Chat patches with runtime transitions", async () => {
    const homePath = await createHome({
      kernel: { model: "claude-opus-4-6", effort: "high" },
      agent: { messagingRuntime: "hermes", revision: 0 },
    });
    let releasePrepare: (() => void) | undefined;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const openclaw = fakeAdapter("openclaw", {
      prepare: vi.fn(async () => prepareGate),
    });
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes: fakeAdapter("hermes"), openclaw },
    });

    const transition = controller.update({ runtime: "openclaw", revision: 0 });
    await vi.waitFor(() => expect(openclaw.prepare).toHaveBeenCalledOnce());
    await expect(controller.updateKernel({ effort: "low" }))
      .rejects.toMatchObject({ kind: "agent_config_conflict" });
    releasePrepare?.();
    await transition;
    await expect(controller.updateKernel({ effort: "low" })).resolves.toEqual({
      model: "claude-opus-4-6",
      effort: "low",
    });

    const config = JSON.parse(await readFile(
      join(homePath, "system/config.json"),
      "utf8",
    ));
    expect(config.agent).toMatchObject({
      messagingRuntime: "openclaw",
      revision: 1,
    });
    expect(config.kernel).toEqual({
      model: "claude-opus-4-6",
      effort: "low",
    });
  });

  it("reconciles a stale transition to the persisted healthy runtime", async () => {
    const homePath = await createHome({
      agent: { messagingRuntime: "hermes", revision: 4 },
    });
    const runtimeDir = join(homePath, "system/agent-runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "transition.lock"), "stale");
    await writeFile(join(runtimeDir, "transition.json"), JSON.stringify({
      id: "6f06cf2c-806f-4c44-b92e-97e041ff088b",
      from: "hermes",
      to: "openclaw",
      state: "verifying",
      startedAt: "2026-07-13T00:00:00.000Z",
      deadlineAt: "2026-07-13T00:00:10.000Z",
    }));
    const calls: string[] = [];
    const controller = createAgentRuntimeController({
      homePath,
      adapters: {
        hermes: fakeAdapter("hermes", {
          activate: vi.fn(async () => { calls.push("hermes:activate"); }),
        }),
        openclaw: fakeAdapter("openclaw", {
          deactivate: vi.fn(async () => { calls.push("openclaw:deactivate"); }),
        }),
      },
      pauseDelivery: vi.fn(async () => { calls.push("delivery:pause"); }),
      resumeDelivery: vi.fn(async (runtime) => {
        calls.push(`delivery:resume:${runtime}`);
      }),
    });

    await controller.reconcile();

    expect(calls).toEqual([
      "delivery:pause",
      "openclaw:deactivate",
      "hermes:activate",
      "delivery:resume:hermes",
    ]);
    await expect(lstat(join(runtimeDir, "transition.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(runtimeDir, "transition.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps gateway startup available when transition cleanup fails", async () => {
    const homePath = await createHome();
    const runtimeDir = join(homePath, "system/agent-runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "transition.json"), JSON.stringify({
      id: "6f06cf2c-806f-4c44-b92e-97e041ff088b",
      from: "openclaw",
      to: "hermes",
      state: "verifying",
      startedAt: "2026-07-13T00:00:00.000Z",
      deadlineAt: "2026-07-13T00:00:10.000Z",
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation((message) => {
      if (message === "[agent-config] Transition marker cleanup failed:") {
        chmodSync(runtimeDir, 0o700);
      }
    });
    const hermes = fakeAdapter("hermes", {
      probe: vi.fn(async () => {
        chmodSync(runtimeDir, 0o500);
        return {
          id: "hermes",
          displayName: "Hermes",
          installState: "installed",
          health: "healthy",
          selectionState: "active",
          configured: true,
          capabilities: ["provider_catalog", "model_selection"],
        };
      }),
    });
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes },
    });

    try {
      await expect(controller.reconcile()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "[agent-config] Transition marker cleanup failed:",
        expect.any(String),
      );
    } finally {
      chmodSync(runtimeDir, 0o700);
      warn.mockRestore();
      await controller.close();
    }
  });

  it("keeps gateway startup available when reconciliation cannot create its directory", async () => {
    const homePath = await createHome({
      kernel: { model: "claude-opus-4-6", effort: "high" },
    });
    await writeFile(join(homePath, "system/agent-runtime"), "not-a-directory");
    const pauseDelivery = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes: fakeAdapter("hermes") },
      pauseDelivery,
    });

    try {
      await expect(controller.reconcile()).resolves.toBeUndefined();
      expect(pauseDelivery).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "[agent-config] Runtime reconciliation failed:",
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
      await controller.close();
    }
  });

  it("ignores untrusted startup lock symlinks without following or removing them", async () => {
    const homePath = await createHome();
    const runtimeDir = join(homePath, "system/agent-runtime");
    await mkdir(runtimeDir, { recursive: true });
    const targetPath = join(homePath, "owner-file");
    await writeFile(targetPath, "preserve-me");
    const lockPath = join(runtimeDir, "transition.lock");
    await symlink(targetPath, lockPath);
    const hermes = fakeAdapter("hermes");
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes },
    });

    await controller.reconcile();

    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("preserve-me");
    expect(hermes.activate).not.toHaveBeenCalled();
  });

  it("rejects malformed startup transition content without logging it", async () => {
    const homePath = await createHome();
    const runtimeDir = join(homePath, "system/agent-runtime");
    await mkdir(runtimeDir, { recursive: true });
    const canary = "sk-secret-transition-canary";
    await writeFile(join(runtimeDir, "transition.json"), canary);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes: fakeAdapter("hermes") },
    });

    try {
      await controller.reconcile();
      expect(warn).toHaveBeenCalledWith(
        "[agent-config] Ignoring invalid runtime transition marker:",
        expect.any(String),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
      await expect(lstat(join(runtimeDir, "transition.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      warn.mockRestore();
    }
  });

  it("aborts and waits for an in-flight transition before closing adapters", async () => {
    const homePath = await createHome();
    let prepareSignal: AbortSignal | undefined;
    const openclaw = fakeAdapter("openclaw", {
      prepare: vi.fn(async (signal) => new Promise<void>((_resolve, reject) => {
        prepareSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      })),
    });
    const hermes = fakeAdapter("hermes");
    const controller = createAgentRuntimeController({
      homePath,
      adapters: { hermes, openclaw },
      timeoutMs: 100,
    });
    const transition = controller.update({ runtime: "openclaw", revision: 0 });
    await vi.waitFor(() => expect(openclaw.prepare).toHaveBeenCalledOnce());

    await controller.close();

    expect(prepareSignal?.aborted).toBe(true);
    await expect(transition).rejects.toMatchObject({
      kind: "runtime_switch_failed",
    });
    expect(hermes.close).toHaveBeenCalledOnce();
    expect(openclaw.close).toHaveBeenCalledOnce();
  });
});
