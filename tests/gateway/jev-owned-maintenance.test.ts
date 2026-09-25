import type pg from "pg";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it, vi } from "vitest";
import { createOwnedJevMaintenance } from "../../packages/gateway/src/jev/owned-maintenance.js";
import { startJevResultCleanup } from "../../packages/gateway/src/jev/result-cleanup.js";
import { initializeJevRuntime } from "../../packages/gateway/src/jev/runtime.js";
import { JevEvaluationRepository } from "../../packages/gateway/src/jev/repository.js";

describe("Jev-owned maintenance database", () => {
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
    const pool = {
      connect: vi.fn(async () => ({ query, release }) as unknown as pg.PoolClient),
      end,
    };
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
    const pool = {
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ command: "UPDATE", rowCount: 0, rows: [] })),
        release,
      }) as unknown as pg.PoolClient),
      end,
    };
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
          return {
            connect: () => new Promise<pg.PoolClient>((_resolve, reject) => {
              setTimeout(() => reject(new Error("connection timeout")), config.connectionTimeoutMillis);
            }),
            end,
          };
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
});
