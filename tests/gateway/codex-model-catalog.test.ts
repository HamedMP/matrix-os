import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createCodexModelCatalogSource,
  normalizeCodexModelCatalog,
} from "../../packages/gateway/src/chat/codex-model-catalog.js";

const SAMPLE_MODEL = {
  id: "gpt-5.6-sol",
  model: "gpt-5.6-sol",
  displayName: "GPT-5.6-Sol",
  description: "Frontier coding model",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
  inputModalities: ["text"],
  serviceTiers: [],
  defaultServiceTier: null,
};

/**
 * A fake `codex app-server --stdio` child: a stdin that captures writes, a
 * stdout that the test drives line-by-line, and a `kill` spy so tests can
 * assert every spawned attempt is actually terminated (never leaked).
 */
function fakeCodexChild(options: { autoCloseOnKill?: boolean } = {}) {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { resume: () => void };
  stderr.resume = () => {};
  const writes: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: { write: (chunk: string) => { writes.push(chunk); return true; } },
  });
  const kill = vi.fn(() => {
    if (options.autoCloseOnKill !== false) queueMicrotask(() => child.emit("close", 0, null));
    return true;
  });
  Object.assign(child, {
    kill,
  });
  return { child, stdout, writes, kill };
}

/** Emits the real model/list handshake so the caller resolves with SAMPLE_MODEL. */
function respondWithRealCatalog(stdout: EventEmitter, writes: string[]) {
  stdout.emit("data", `${JSON.stringify({ id: 1, result: {} })}\n`);
  queueMicrotask(() => {
    const request = JSON.parse(writes[writes.length - 1]!) as { id?: number };
    if (request.id !== 2) return;
    stdout.emit(
      "data",
      `${JSON.stringify({ id: 2, result: { data: [SAMPLE_MODEL], nextCursor: null } })}\n`,
    );
  });
}

describe("Codex model catalog projection", () => {
  it("projects live app-server models and their effort/service-tier options", () => {
    const catalog = normalizeCodexModelCatalog({
      data: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Frontier coding model",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "high", description: "Deep" },
        ],
        inputModalities: ["text", "image"],
        serviceTiers: [{ id: "priority", name: "Fast", description: "Priority capacity" }],
        defaultServiceTier: "priority",
      }, {
        id: "hidden-model",
        model: "hidden-model",
        displayName: "Hidden",
        description: "Hidden",
        hidden: true,
        isDefault: false,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [],
      }],
      nextCursor: null,
    });

    expect(catalog).toMatchObject({
      defaultModel: "gpt-5.6-sol",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        capabilities: ["reasoning", "tools", "vision"],
        supportsVision: true,
      }],
      options: [{
        id: "effort",
        defaultValue: "low",
        values: [{ value: "low" }, { value: "high" }],
      }, {
        id: "service_tier",
        defaultValue: "priority",
        values: [{ value: "priority", label: "Fast" }],
      }],
    });
  });
});

const codexProvider = { id: "codex", kind: "codex" } as Parameters<
  ReturnType<typeof createCodexModelCatalogSource>
>[0];

describe("Codex model catalog source retry and cache behavior", () => {
  it("retries once after a transient app-server failure and returns real models", async () => {
    const attempts: ReturnType<typeof fakeCodexChild>[] = [];
    const spawnProcess = vi.fn(() => {
      const attempt = fakeCodexChild();
      attempts.push(attempt);
      return attempt.child as never;
    });
    const source = createCodexModelCatalogSource({
      executable: "/opt/matrix/runtime/node/bin/codex",
      cwd: "/home/matrix/home",
      maxAttempts: 2,
      retryDelayMs: 1,
      spawnProcess,
    });

    const resultPromise = source(codexProvider);
    // First attempt fails immediately (e.g. a transient spawn/handshake error).
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(1));
    attempts[0]!.child.emit("error", new Error("transient failure"));
    // Second attempt succeeds with a real catalog.
    await vi.waitFor(() => expect(attempts.length).toBe(2));
    respondWithRealCatalog(attempts[1]!.stdout, attempts[1]!.writes);

    const result = await resultPromise;

    expect(result?.models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    // The failed first attempt's process must be terminated, not leaked.
    expect(attempts[0]!.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not start a retry until the previous app-server child has actually exited", async () => {
    const attempts: ReturnType<typeof fakeCodexChild>[] = [];
    const spawnProcess = vi.fn(() => {
      const attempt = fakeCodexChild({ autoCloseOnKill: false });
      attempts.push(attempt);
      return attempt.child as never;
    });
    const source = createCodexModelCatalogSource({
      executable: "/opt/matrix/runtime/node/bin/codex",
      cwd: "/home/matrix/home",
      maxAttempts: 2,
      retryDelayMs: 1,
      spawnProcess,
    });

    const resultPromise = source(codexProvider);
    await vi.waitFor(() => expect(attempts.length).toBe(1));
    attempts[0]!.child.emit("error", new Error("transient failure"));

    expect(attempts[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    attempts[0]!.child.emit("close", 0, null);
    await vi.waitFor(() => expect(attempts.length).toBe(2));
    respondWithRealCatalog(attempts[1]!.stdout, attempts[1]!.writes);

    await expect(resultPromise).resolves.toMatchObject({ models: [{ id: "gpt-5.6-sol" }] });
  });

  it("gives up after exhausting bounded retries without leaking any app-server child", async () => {
    const attempts: ReturnType<typeof fakeCodexChild>[] = [];
    const spawnProcess = vi.fn(() => {
      const attempt = fakeCodexChild();
      attempts.push(attempt);
      return attempt.child as never;
    });
    const source = createCodexModelCatalogSource({
      executable: "/opt/matrix/runtime/node/bin/codex",
      cwd: "/home/matrix/home",
      maxAttempts: 2,
      retryDelayMs: 1,
      spawnProcess,
    });

    const resultPromise = source(codexProvider);
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(1));
    attempts[0]!.child.emit("error", new Error("still failing"));
    await vi.waitFor(() => expect(attempts.length).toBe(2));
    attempts[1]!.child.emit("error", new Error("still failing"));

    await expect(resultPromise).rejects.toThrow();
    // Bounded: never more than the configured number of attempts.
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    // Every spawned attempt was terminated -- none left running.
    for (const attempt of attempts) {
      expect(attempt.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });

  it("does not re-spawn app-server for a request served from the success cache", async () => {
    const attempts: ReturnType<typeof fakeCodexChild>[] = [];
    const spawnProcess = vi.fn(() => {
      const attempt = fakeCodexChild();
      attempts.push(attempt);
      return attempt.child as never;
    });
    const source = createCodexModelCatalogSource({
      executable: "/opt/matrix/runtime/node/bin/codex",
      cwd: "/home/matrix/home",
      cacheTtlMs: 60_000,
      spawnProcess,
    });

    const first = source(codexProvider);
    await vi.waitFor(() => expect(attempts.length).toBe(1));
    respondWithRealCatalog(attempts[0]!.stdout, attempts[0]!.writes);
    await first;

    await source(codexProvider);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("caches an exhausted failure briefly so repeated polling cannot retry-storm a down Codex", async () => {
    const attempts: ReturnType<typeof fakeCodexChild>[] = [];
    const spawnProcess = vi.fn(() => {
      const attempt = fakeCodexChild();
      attempts.push(attempt);
      return attempt.child as never;
    });
    const source = createCodexModelCatalogSource({
      executable: "/opt/matrix/runtime/node/bin/codex",
      cwd: "/home/matrix/home",
      maxAttempts: 1,
      failureCacheTtlMs: 50,
      spawnProcess,
    });

    const first = source(codexProvider);
    await vi.waitFor(() => expect(attempts.length).toBe(1));
    attempts[0]!.child.emit("error", new Error("down"));
    await expect(first).rejects.toThrow();

    // Polled again immediately: must not spawn a second app-server process.
    await expect(source(codexProvider)).rejects.toThrow();
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    // Once the short failure cache expires, the next request retries.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const retried = source(codexProvider);
    await vi.waitFor(() => expect(attempts.length).toBe(2));
    respondWithRealCatalog(attempts[1]!.stdout, attempts[1]!.writes);
    await expect(retried).resolves.toMatchObject({ models: [{ id: "gpt-5.6-sol" }] });
  });
});
