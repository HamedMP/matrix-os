import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelConfig } from "@matrix-os/kernel";
import { createDispatcher, type SpawnFn } from "../../packages/gateway/src/dispatcher.js";

let homePath: string;
beforeEach(async () => { homePath = await mkdtemp(join(tmpdir(), "credential-authority-")); });
afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });

describe("trusted isolated gateway credential authority", () => {
  it("uses the injected authority before an SDK launch without an owner key file", async () => {
    const configs: KernelConfig[] = [];
    const spawnFn = vi.fn<SpawnFn>(async function* (_message, config) {
      configs.push(config); yield { type: "result", data: { sessionId: "isolated", cost: 0, turns: 1 } };
    });
    const kernelCredentialResolver = vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "bounded-runtime-lease", ANTHROPIC_BASE_URL: "https://relay.example.com" }, fundedRunTimeoutMs: 60_000 }));
    const signal = new AbortController();
    const dispatcher = createDispatcher({ homePath, model: "claude-sonnet-5", spawnFn, kernelCredentialResolver });
    await dispatcher.dispatch("task", undefined, () => {}, undefined, signal);
    expect(kernelCredentialResolver).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5", signal: signal.signal, requestClass: "interactive" }));
    expect(configs[0].env?.ANTHROPIC_API_KEY).toBe("bounded-runtime-lease");
    expect(configs[0].env?.ANTHROPIC_BASE_URL).toBe("https://relay.example.com");
  });

  it("rejects before spawn when the injected authority denies and never falls back", async () => {
    const spawnFn = vi.fn<SpawnFn>(async function* () { throw Error("must not launch"); });
    const kernelCredentialResolver = vi.fn(async () => { throw Error("Matrix AI unavailable"); });
    const dispatcher = createDispatcher({ homePath, spawnFn, kernelCredentialResolver });
    await expect(dispatcher.dispatch("task", undefined, () => {})).rejects.toThrow("Matrix AI unavailable");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("uses the same authority for background batch jobs", async () => {
    const spawnFn = vi.fn<SpawnFn>(async function* () { yield { type: "result", data: { sessionId: "batch", cost: 0, turns: 1 } }; });
    const kernelCredentialResolver = vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "bounded-runtime-lease" } }));
    const dispatcher = createDispatcher({ homePath, model: "claude-sonnet-5", spawnFn, kernelCredentialResolver });
    const result = await dispatcher.dispatchBatch([{ taskId: "task_1", message: "task", onEvent: () => {} }]);
    expect(result[0].status).toBe("fulfilled");
    expect(kernelCredentialResolver).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5", requestClass: "background" }));
  });
});
