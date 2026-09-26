import type pg from "pg";
import { EventEmitter } from "node:events";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it, vi } from "vitest";
import { createOwnedJevMaintenance } from "../../packages/gateway/src/jev/owned-maintenance.js";
import { startJevResultCleanup } from "../../packages/gateway/src/jev/result-cleanup.js";
import { initializeJevRuntime } from "../../packages/gateway/src/jev/runtime.js";
import { JevEvaluationRepository } from "../../packages/gateway/src/jev/repository.js";

describe("Jev-owned maintenance database", () => {
  it("logs an idle pool error without exposing its message or crashing", async () => {
    const pool = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => { throw new Error("unused"); }),
      end: vi.fn(async () => undefined),
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const maintenance = createOwnedJevMaintenance({
        databaseUrl: "postgres://isolated-test/owner",
        poolFactory: () => pool,
      });
      expect(() => pool.emit("error", new Error("private database host and token"))).not.toThrow();
      expect(log).toHaveBeenCalledWith("[jev] Idle maintenance pool error:", "Error");
      await maintenance.close();
    } finally {
      log.mockRestore();
    }
  });

  it("force-releases only its own stuck client before pool teardown", async () => {
    let resolveQuery: ((result: { command: "UPDATE"; rowCount: number; rows: [] }) => void) | undefined;
    let forced = false;
    const release = vi.fn((destroy?: boolean) => { forced = destroy === true; });
    const query = vi.fn(() => new Promise<{ command: "UPDATE"; rowCount: number; rows: [] }>((resolve) => {
      resolveQuery = resolve;
    }));
    const end = vi.fn(async () => {
      if (!forced) await new Promise<void>(() => undefined);
    });
    const pool = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => ({ query, release }) as unknown as pg.PoolClient),
      end,
    });
    let config: pg.PoolConfig | undefined;
    const maintenance = createOwnedJevMaintenance({
      databaseUrl: "postgres://isolated-test/owner",
      poolFactory(input) { config = input; return pool; },
    });
    const lifecycle = startJevResultCleanup({
      repository: maintenance.repository,
      abortInFlight: maintenance.forceReleaseActive,
      schedule: () => "timer",
      cancel: () => undefined,
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    const pending = lifecycle.runNow();

    vi.useFakeTimers();
    try {
      const closing = lifecycle.close();
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;
    } finally {
      vi.useRealTimers();
    }
    await maintenance.close();
    await maintenance.close();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
    expect(end).toHaveBeenCalledTimes(1);
    expect(config).toMatchObject({
      max: 1,
      connectionTimeoutMillis: 3_000,
      query_timeout: 4_000,
      statement_timeout: 4_000,
    });

    resolveQuery?.({ command: "UPDATE", rowCount: 0, rows: [] });
    await pending;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("closes its owned pool while leaving the shared owner database usable", async () => {
    const pglite = await KyselyPGlite.create();
    const shared = new JevEvaluationRepository(pglite.dialect);
    const release = vi.fn();
    const end = vi.fn(async () => undefined);
    const pool = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ command: "UPDATE", rowCount: 0, rows: [] })),
        release,
      }) as unknown as pg.PoolClient),
      end,
    });
    const runtime = await initializeJevRuntime({
      db: shared.kysely,
      databaseUrl: "postgres://isolated-test/owner",
      credentialProvider: null,
      fundedRuntimeEnabled: false,
      maintenancePoolFactory: () => pool,
      schedule: () => "timer",
      cancel: () => undefined,
    });
    await runtime?.cleanup.runNow();
    await runtime?.cleanup.close();
    expect(end).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(sql<{ value: number }>`SELECT 1 AS value`.execute(shared.kysely))
      .resolves.toMatchObject({ rows: [{ value: 1 }] });
    await shared.destroy();
  });

  it("configures a bounded acquisition and closes after its timeout", async () => {
    vi.useFakeTimers();
    try {
      const end = vi.fn(async () => undefined);
      const maintenance = createOwnedJevMaintenance({
        databaseUrl: "postgres://isolated-test/owner",
        poolFactory(config) {
          return Object.assign(new EventEmitter(), {
            connect: () => new Promise<pg.PoolClient>((_resolve, reject) => {
              setTimeout(() => reject(new Error("connection timeout")), config.connectionTimeoutMillis);
            }),
            end,
          });
        },
      });
      const onError = vi.fn();
      const lifecycle = startJevResultCleanup({
        repository: maintenance.repository,
        abortInFlight: maintenance.forceReleaseActive,
        onError,
        schedule: () => "timer",
        cancel: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(onError).toHaveBeenCalledTimes(1);
      await lifecycle.close();
      await maintenance.close();
      expect(end).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys a connection acquired after close begins without issuing a query", async () => {
    let resolveConnect: ((client: pg.PoolClient) => void) | undefined;
    let resolveEnd: (() => void) | undefined;
    const query = vi.fn();
    const release = vi.fn((destroy?: boolean) => {
      if (destroy === true) resolveEnd?.();
    });
    const client = { query, release } as unknown as pg.PoolClient;
    const end = vi.fn(() => new Promise<void>((resolve) => { resolveEnd = resolve; }));
    const pool = Object.assign(new EventEmitter(), {
      connect: vi.fn(() => new Promise<pg.PoolClient>((resolve) => { resolveConnect = resolve; })),
      end,
    });
    const maintenance = createOwnedJevMaintenance({
      databaseUrl: "postgres://isolated-test/owner",
      poolFactory: () => pool,
    });
    const pending = maintenance.repository.pruneExpiredCompletedResults()
      .then(() => undefined, (error: unknown) => error);
    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalledTimes(1));

    const closing = maintenance.close();
    await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
    resolveConnect?.(client);
    await closing;
    await pending;
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
    expect(query).not.toHaveBeenCalled();
    await maintenance.close();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
