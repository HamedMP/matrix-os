import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanonicalPlatformTestDb } from "./canonical-phase-postgres.js";

// Observe real driver resources, without replacing queries or database outcomes.
const pools = vi.hoisted(() => [] as pg.Pool[]);
vi.mock("pg", async importOriginal => {
  const actual = await importOriginal<typeof import("pg")>();
  class TrackedPool extends actual.default.Pool {
    constructor(options?: pg.PoolConfig) { super(options); pools.push(this); }
  }
  return { ...actual, default: { ...actual.default, Pool: TrackedPool } };
});
const actualPg = await vi.importActual<typeof import("pg")>("pg");
const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)("dedicated canonical PostgreSQL fixture cleanup", () => {
  let control: pg.Pool;
  let suffix: string;
  let role: string;
  beforeEach(async () => {
    const url = new URL(connectionString!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.pathname.toLowerCase().includes("test")) {
      throw new Error("Dedicated loopback test Postgres is required");
    }
    suffix = randomUUID().replaceAll("-", ""); role = `fixture_role_${suffix}`;
    pools.length = 0;
    control = new actualPg.default.Pool({ connectionString, max: 1 });
  });
  afterEach(async () => {
    process.env.MATRIX_TEST_POSTGRES_URL = connectionString;
    try {
      await control.query(`drop event trigger if exists fixture_drop_${suffix}`);
      await control.query(`drop function if exists public.fixture_drop_${suffix}()`);
      for (const pool of pools) {
        if (!pool.ended) await pool.end();
        const schema = pool.options.options?.match(/search_path=(canonical_readiness_[a-f0-9]{32})/)?.[1];
        if (schema) await control.query(`drop schema if exists "${schema}" cascade`);
      }
      await control.query(`drop role if exists "${role}"`);
    } finally { await control.end(); }
  });

  it("closes the real admin pool when CREATE SCHEMA is denied", async () => {
    await control.query(`create role "${role}" login password 'fixture_test'`);
    const url = new URL(connectionString!); url.username = role; url.password = "fixture_test";
    process.env.MATRIX_TEST_POSTGRES_URL = url.toString();
    await expect(createCanonicalPlatformTestDb()).rejects.toMatchObject({ code: "42501" });
    expect(pools).toHaveLength(1);
    expect(pools[0].ended).toBe(true);
    expect(pools[0].totalCount).toBe(0);
  });

  it("closes both real pools when DROP SCHEMA is denied", async () => {
    await control.query(`create function public.fixture_drop_${suffix}() returns event_trigger language plpgsql as $$
      begin
        if exists (select 1 from pg_event_trigger_dropped_objects()
          where object_type = 'schema' and object_name like 'canonical_readiness_%') then
          raise exception 'fixture drop denied' using errcode = '42501';
        end if;
      end;
    $$`);
    await control.query(`create event trigger fixture_drop_${suffix} on sql_drop
      execute function public.fixture_drop_${suffix}()`);
    const fixture = await createCanonicalPlatformTestDb();
    await expect(fixture.close()).rejects.toMatchObject({ code: "42501" });
    expect(pools).toHaveLength(2);
    expect(pools.map(pool => pool.ended)).toEqual([true, true]);
    expect(pools.map(pool => pool.totalCount)).toEqual([0, 0]);
  });
});
