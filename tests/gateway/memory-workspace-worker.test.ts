import { describe, expect, it, vi } from "vitest";
import { MemoryIngestionWorker } from "../../packages/gateway/src/memory-workspace/ingestion-worker.js";
import type { MemoryWorkspaceRepository } from "../../packages/gateway/src/memory-workspace/repository.js";
const job = {
  id: "j",
  ownerId: "alice",
  sourceId: "s",
  revision: 1,
  engine: "hindsight" as const,
  operation: "upsert" as const,
  leaseToken: "l",
};
function setup(source: unknown, operation = "upsert") {
  const repo = {
    prune: vi.fn(async () => {}),
    claimJob: vi.fn(async (_engine: string) => ({ ...job, operation })),
    getSource: vi.fn(async () => source),
    finishJob: vi.fn(async () => true),
  };
  const engine = {
    id: "hindsight" as const,
    upsert: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    search: vi.fn(async () => []),
  };
  return {
    repo,
    engine,
    worker: new MemoryIngestionWorker(
      repo as unknown as MemoryWorkspaceRepository,
      { hindsight: engine },
    ),
  };
}
describe("memory worker", () => {
  it("cleans only an obsolete revision even after restoring a source", async () => {
    const { repo, engine, worker } = setup({ revision: 2 }, "delete");
    await worker.tick();
    expect(engine.delete).toHaveBeenCalledWith(
      "alice",
      "s",
      1,
      expect.any(AbortSignal),
    );
    expect(repo.finishJob).toHaveBeenCalledWith("j", "l", true);
  });
  it("propagates tombstones and records failures without blocking the other lane", async () => {
    const { repo, engine, worker } = setup(null);
    await worker.tick();
    expect(engine.delete).toHaveBeenCalled();
    engine.delete.mockRejectedValueOnce(new Error("engine unavailable"));
    await worker.tick();
    expect(repo.finishJob).toHaveBeenLastCalledWith("j", "l", false);
  });
  it("drains its active cycle before close returns", async () => {
    vi.useFakeTimers();
    const { repo, engine, worker } = setup({ revision: 1 });
    let finish!: () => void;
    engine.upsert.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(repo.finishJob).toHaveBeenCalled();
    expect(closed).toBe(true);
    vi.useRealTimers();
  });
});

it("drains the other lane after one database claim fails", async () => {
  vi.useFakeTimers();
  try {
    const f = setup({ revision: 1 });
    let release!: () => void;
    f.repo.claimJob.mockImplementation(async (engine) => {
      if (engine === "hindsight") throw Error("database");
      return { ...job, engine: "openviking" as const, operation: "upsert" };
    });
    const other = {
      ...f.engine,
      id: "openviking" as const,
      upsert: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const worker = new MemoryIngestionWorker(
      f.repo as unknown as MemoryWorkspaceRepository,
      { hindsight: f.engine, openviking: other },
    );
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(f.repo.finishJob).toHaveBeenCalledWith("j", "l", true);
  } finally {
    vi.useRealTimers();
  }
});

it("cleans a late old upsert without deleting the restored revision", async () => {
  const f = setup({ revision: 1 });
  const documents = new Map<number, string>();
  let complete!: () => void;
  f.engine.upsert.mockImplementationOnce(async (_owner, source) => {
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    documents.set(source.revision, "old");
  });
  f.engine.delete.mockImplementationOnce(async (_owner, _id, revision) => {
    documents.delete(revision);
  });
  const running = f.worker.tick();
  while (!complete) await Promise.resolve();
  f.repo.getSource.mockResolvedValue({ revision: 3 });
  documents.set(3, "restored");
  complete();
  await running;
  expect(documents.get(3)).toBe("restored");
  expect(documents.has(1)).toBe(false);
  expect(f.engine.delete).toHaveBeenCalledWith(
    "alice",
    "s",
    1,
    expect.any(AbortSignal),
  );
});
