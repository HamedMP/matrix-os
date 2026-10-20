import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { PostgresWorkspaceRepository, type WorkspaceDatabase } from "../../packages/workspace-worker/src/data/repository.js";
import { PostgresRuntimeStore } from "../../packages/workspace-worker/src/data/runtime-store.js";

describe("Postgres runtime fencing", () => {
  let engine: Awaited<ReturnType<typeof createTestPGlite>>;
  let repository: PostgresWorkspaceRepository;
  let store: PostgresRuntimeStore;
  beforeAll(async () => {
    engine = await createTestPGlite();
    repository = new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({ dialect: engine.dialect }));
    await repository.initialize(); store = new PostgresRuntimeStore(repository.db); await store.initialize();
  });
  afterAll(async () => { await repository?.close(); if (engine && !engine.client.closed) await engine.client.close(); });
  it("claims idempotently with cap and owner isolation", async () => {
    const job = { ownerId: "owner1", jobId: "job1", type: "chat" as const };
    expect(await store.claim(job, 100, 1000, 5000)).toMatchObject({ generation: 1, expiresAt: 1100 });
    expect(await store.claim(job, 100, 1000, 5000)).toBeNull();
    await expect(store.claim({ ...job, jobId: "job2" }, 100, 1000, 5000)).rejects.toMatchObject({ name: "RuntimeBusyError" });
    expect((await store.active("owner2", 100))).toEqual([]);
  });
  it("does not resurrect expired leases and records interruption", async () => {
    const active = await store.active("owner1", 1200);
    expect(active).toHaveLength(1);
    expect(await store.heartbeat(active[0], 1200, 1000)).toBe(false);
    await store.recoverExpired("owner1", 1200);
    expect(await store.active("owner1", 1200)).toEqual([]);
    expect((await store.status("owner1")).idleSince).toBe(1200);
  });
  it("checkpoints fence new claims and old generations", async () => {
    expect(await store.beginCheckpoint("owner1", 1250, 100)).toBeNull();
    const generation = await store.beginCheckpoint("owner1", 1400, 100);
    expect(generation).toBe(1);
    await expect(store.claim({ ownerId: "owner1", jobId: "new", type: "wake" }, 1400, 1000, 5000)).rejects.toMatchObject({ name: "RuntimeBusyError" });
    expect(await store.markSleeping("owner1", 1)).toBe(false);
    expect(await store.saveCheckpoint("owner1", { backup: { id: "r2" }, createdAt: 1400, generation: 1 })).toBe(true);
    expect(await store.markSleeping("owner1", 1)).toBe(true);
    expect((await store.status("owner1")).generation).toBe(2);
    expect(await store.saveCheckpoint("owner1", { backup: {}, createdAt: 1500, generation: 1 })).toBe(false);
  });
  it("resumes a persisted checkpoint transition after a Durable Object restart", async () => {
    const owner = "checkpoint_restart";
    const lease = (await store.claim({ownerId:owner,jobId:"save",type:"wake"},0,1000,5000))!;
    await store.finish(lease,"completed",20);
    expect(await store.beginCheckpoint(owner,200,100)).toBe(1);
    // A fresh controller must recover the committed state even if the previous
    // isolate vanished before the archive/pointer publication completed.
    const restarted = new PostgresRuntimeStore(repository.db);
    expect(await restarted.beginCheckpoint(owner,220,100)).toBe(1);
    await expect(restarted.claim({ownerId:owner,jobId:"racing",type:"wake"},220,1000,5000)).rejects.toMatchObject({name:"RuntimeBusyError"});
    expect(await restarted.saveCheckpoint(owner,{backup:{id:"recovered"},createdAt:230,generation:1})).toBe(true);
    expect(await restarted.markSleeping(owner,1)).toBe(true);
    expect(await restarted.beginCheckpoint(owner,250,100)).toBeNull();
  });
  it("a completed lease cannot renew and starts idle grace", async () => {
    const first = (await store.claim({ ownerId: "owner3", jobId: "a", type: "chat" }, 0, 1000, 5000))!;
    expect(await store.finish(first, "completed", 20)).toBe(true);
    expect((await store.status("owner3")).idleSince).toBe(20);
    expect(await store.heartbeat(first, 20, 1000)).toBe(false);
    const second = (await store.claim({ ownerId: "owner3", jobId: "b", type: "chat" }, 30, 1000, 5000))!;
    expect((await store.status("owner3")).idleSince).toBeNull();
    expect(await store.finish(second, "completed", 40)).toBe(true);
    expect((await store.status("owner3")).idleSince).toBe(40);
  });
  it("rebinds only the same runtime owner", async () => {
    await store.bindRuntime("runtime1", "owner1");
    expect(await store.ownerForRuntime("runtime1")).toBe("owner1");
    await expect(store.bindRuntime("runtime1", "owner2")).rejects.toThrow();
  });
});

describe("durable interrupt fencing", () => {
  it("blocks claims during destruction and rejects stale cancellation after a new generation starts", async () => {
    const engine = await createTestPGlite();
    const repository = new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({ dialect: engine.dialect }));
    await repository.initialize();
    const store = new PostgresRuntimeStore(repository.db); await store.initialize();
    const a = (await store.claim({ ownerId: "interrupt_owner", jobId: "a", type: "chat" }, 0, 100, 1000))!;
    expect(await store.beginInterrupt(a, 110)).toBe(2);
    expect(await store.active("interrupt_owner", 110)).toEqual([]);
    await expect(store.claim({ ownerId: "interrupt_owner", jobId: "b", type: "chat" }, 110, 100, 1000)).rejects.toMatchObject({ name: "RuntimeBusyError" });
    // Runtime destruction completed; only now is the new generation runnable.
    await store.fail("interrupt_owner", 2);
    const b = (await store.claim({ ownerId: "interrupt_owner", jobId: "b", type: "chat" }, 120, 100, 1000))!;
    expect(b.generation).toBe(2);
    expect(await store.beginInterrupt(a, 120)).toBeNull();
    expect(await store.finish(a, "interrupted", 120)).toBe(false);
    expect((await store.status("interrupt_owner")).state).toBe("running");
    await repository.close(); if (!engine.client.closed) await engine.client.close();
  });
});

describe("bounded failed idle checkpoint fencing", () => {
  it("quarantines only a current idle pooled generation and never interrupts active or personal work", async () => {
    const engine = await createTestPGlite();
    const repository = new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({ dialect: engine.dialect }));
    await repository.initialize();
    const store = new PostgresRuntimeStore(repository.db); await store.initialize();
    const lease = (await store.claim({ ownerId: "idle_owner", jobId: "idle_job", type: "wake" }, 0, 1000, 5000))!;
    expect(await store.beginIdleInterrupt("idle_owner", lease.generation, 100)).toBeNull();
    await store.finish(lease, "completed", 100);
    expect(await store.beginIdleInterrupt("idle_owner", lease.generation + 1, 200)).toBeNull();
    expect(await store.beginIdleInterrupt("idle_owner", lease.generation, 200)).toBe(2);
    expect((await store.status("idle_owner")).state).toBe("interrupting");
    expect(await store.beginIdleInterrupt("idle_owner", lease.generation, 200)).toBeNull();
    await expect(store.claim({ ownerId: "idle_owner", jobId: "next", type: "wake" }, 200, 1000, 5000)).rejects.toMatchObject({ name: "RuntimeBusyError" });
    await store.fail("idle_owner", 2);
    await repository.db.updateTable("shared_workspaces").set({ placement: "personal" }).where("owner_id", "=", "idle_owner").execute();
    expect(await store.beginIdleInterrupt("idle_owner", 2, 300)).toBeNull();
    await repository.close(); if (!engine.client.closed) await engine.client.close();
  });
});
