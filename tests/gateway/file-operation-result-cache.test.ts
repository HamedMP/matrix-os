import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileOperationRequestIdConflictError,
  FileOperationResultCache,
  hashBatchMoveExecutePayload,
  hashBatchMovePreflightPayload,
} from "../../packages/gateway/src/file-management/result-cache.js";

const REQUEST_ID = "a9d9d1d8-8e5d-45d0-8d17-2c85f4e19a11";

describe("FileOperationResultCache", () => {
  let cache: FileOperationResultCache;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
    cache = new FileOperationResultCache();
  });

  afterEach(() => {
    cache.close();
    vi.useRealTimers();
  });

  it("evicts the least recently used result after 512 entries", async () => {
    let executions = 0;
    const run = (requestId: string) => cache.run({
      ownerId: "owner-a",
      namespace: "move:preflight",
      requestId,
      payloadHash: `payload-${requestId}`,
    }, async () => ++executions);

    for (let index = 0; index < 512; index += 1) {
      await run(`request-${index}`);
    }
    await run("request-0");
    await run("request-512");

    await run("request-0");
    await run("request-1");
    expect(executions).toBe(514);
  });

  it("expires results after ten minutes", async () => {
    let executions = 0;
    const input = {
      ownerId: "owner-a",
      namespace: "move:preflight",
      requestId: REQUEST_ID,
      payloadHash: "payload",
    };

    await cache.run(input, async () => ++executions);
    await vi.advanceTimersByTimeAsync(600_001);
    await cache.run(input, async () => ++executions);

    expect(executions).toBe(2);
  });

  it("replays an identical completed request without re-executing it", async () => {
    let executions = 0;
    const input = {
      ownerId: "owner-a",
      namespace: "move:preflight",
      requestId: REQUEST_ID,
      payloadHash: "payload",
    };

    await expect(cache.run(input, async () => ({ execution: ++executions }))).resolves.toEqual({ execution: 1 });
    await expect(cache.run(input, async () => ({ execution: ++executions }))).resolves.toEqual({ execution: 1 });
    expect(executions).toBe(1);
  });

  it("shares one promise for identical in-flight requests", async () => {
    let resolveOperation: ((value: string) => void) | undefined;
    let executions = 0;
    const input = {
      ownerId: "owner-a",
      namespace: "move:preflight",
      requestId: REQUEST_ID,
      payloadHash: "payload",
    };
    const operation = () => new Promise<string>((resolve) => {
      executions += 1;
      resolveOperation = resolve;
    });

    const first = cache.run(input, operation);
    const second = cache.run(input, operation);
    await vi.advanceTimersByTimeAsync(0);
    expect(executions).toBe(1);
    resolveOperation?.("moved");

    await expect(Promise.all([first, second])).resolves.toEqual(["moved", "moved"]);
  });

  it("retains all 512 pending identities instead of evicting one for a 513th request", async () => {
    const resolvers: Array<(value: number) => void> = [];
    let executions = 0;
    const inputs = Array.from({ length: 512 }, (_, index) => ({
      ownerId: "owner-a",
      namespace: "move:execute",
      requestId: `pending-${index}`,
      payloadHash: `payload-${index}`,
    }));
    const pending = inputs.map((input, index) => cache.run(input, () => new Promise<number>((resolve) => {
      executions += 1;
      resolvers[index] = resolve;
    })));

    await vi.advanceTimersByTimeAsync(0);
    await expect(cache.run({
      ownerId: "owner-a",
      namespace: "move:execute",
      requestId: "pending-512",
      payloadHash: "payload-512",
    }, async () => ++executions)).rejects.toMatchObject({ code: "operation_unavailable" });

    expect(cache.run(inputs[0]!, async () => ++executions)).toBe(pending[0]);
    expect(executions).toBe(512);
    for (const [index, resolve] of resolvers.entries()) resolve(index);
    await expect(Promise.all(pending)).resolves.toHaveLength(512);
  });

  it("rejects a reused request identifier whose canonical payload differs", async () => {
    await cache.run({
      ownerId: "owner-a",
      namespace: "move:preflight",
      requestId: REQUEST_ID,
      payloadHash: "first",
    }, async () => "first");

    await expect(cache.run({
      ownerId: "owner-a",
      namespace: "move:preflight",
      requestId: REQUEST_ID,
      payloadHash: "second",
    }, async () => "second")).rejects.toBeInstanceOf(FileOperationRequestIdConflictError);
  });

  it("keeps preflight and execute cache namespaces separate for one request identifier", async () => {
    const preflightPayload = hashBatchMovePreflightPayload({
      phase: "preflight",
      sources: ["projects/a/one.md"],
      destinationDirectory: "projects/archive",
    });
    const executePayload = hashBatchMoveExecutePayload({
      phase: "execute",
      preflightFingerprint: "fingerprint",
      conflictChoices: [{ source: "projects/a/one.md", resolution: "keep-both" }],
    });

    await expect(cache.run({ ownerId: "owner-a", namespace: "move:preflight", requestId: REQUEST_ID, payloadHash: preflightPayload }, async () => "preflight"))
      .resolves.toBe("preflight");
    await expect(cache.run({ ownerId: "owner-a", namespace: "move:execute", requestId: REQUEST_ID, payloadHash: executePayload }, async () => "execute"))
      .resolves.toBe("execute");
  });

  it("isolates identical client request identifiers between authenticated owners", async () => {
    const input = {
      namespace: "move:preflight",
      requestId: REQUEST_ID,
      payloadHash: "payload",
    };

    await expect(cache.run({ ...input, ownerId: "owner-a" }, async () => "owner-a")).resolves.toBe("owner-a");
    await expect(cache.run({ ...input, ownerId: "owner-b" }, async () => "owner-b")).resolves.toBe("owner-b");
  });
});
