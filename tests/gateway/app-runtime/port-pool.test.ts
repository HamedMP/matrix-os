import { describe, it, expect, beforeEach } from "vitest";
import { PortPool } from "../../../packages/gateway/src/app-runtime/port-pool.js";
import { SpawnError } from "../../../packages/gateway/src/app-runtime/errors.js";

describe("PortPool", () => {
  let pool: PortPool;

  beforeEach(() => {
    pool = new PortPool({ min: 40000, max: 40010 });
  });

  it("allocates ports from the configured range", () => {
    const p1 = pool.allocate();
    const p2 = pool.allocate();
    expect(p1).toBeGreaterThanOrEqual(40000);
    expect(p1).toBeLessThanOrEqual(40010);
    expect(p2).toBeGreaterThanOrEqual(40000);
    expect(p2).toBeLessThanOrEqual(40010);
    expect(p2).not.toBe(p1);
  });

  it("allocates all ports in the range without duplicates", () => {
    const allocated = new Set<number>();
    for (let i = 0; i <= 10; i++) {
      allocated.add(pool.allocate());
    }
    expect(allocated.size).toBe(11);
    for (const p of allocated) {
      expect(p).toBeGreaterThanOrEqual(40000);
      expect(p).toBeLessThanOrEqual(40010);
    }
  });

  it("releases ports back to the pool for reuse", () => {
    const pool2 = new PortPool({ min: 40000, max: 40001 });
    const p1 = pool2.allocate();
    const p2 = pool2.allocate();
    expect(() => pool2.allocate()).toThrow(SpawnError);
    pool2.release(p1);
    const p3 = pool2.allocate();
    expect(p3).toBe(p1);
  });

  it("throws SpawnError with port_exhausted when pool is empty", () => {
    const pool1 = new PortPool({ min: 40000, max: 40000 });
    pool1.allocate();
    try {
      pool1.allocate();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SpawnError);
      expect((err as SpawnError).code).toBe("port_exhausted");
    }
  });

  it("ignores release of port outside the range (idempotent)", () => {
    expect(() => pool.release(39999)).not.toThrow();
    expect(() => pool.release(50000)).not.toThrow();
  });

  it("ignores release of port that was never allocated (idempotent)", () => {
    expect(() => pool.release(40005)).not.toThrow();
  });

  it("double release is idempotent", () => {
    const p = pool.allocate();
    pool.release(p);
    expect(() => pool.release(p)).not.toThrow();
  });

  it("tracks in-use ports via inUse()", () => {
    expect(pool.inUse()).toEqual([]);
    const p1 = pool.allocate();
    const p2 = pool.allocate();
    const used = pool.inUse();
    expect(used).toContain(p1);
    expect(used).toContain(p2);
    expect(used).toHaveLength(2);
    pool.release(p1);
    expect(pool.inUse()).not.toContain(p1);
    expect(pool.inUse()).toContain(p2);
  });

  it("respects the cap parameter to limit concurrent allocations", () => {
    const capped = new PortPool({ min: 40000, max: 49999, cap: 3 });
    capped.allocate();
    capped.allocate();
    capped.allocate();
    try {
      capped.allocate();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SpawnError);
      expect((err as SpawnError).code).toBe("port_exhausted");
    }
  });

  it("defaults to the full 40000-49999 range with cap 100", () => {
    const defaultPool = new PortPool();
    const p = defaultPool.allocate();
    expect(p).toBeGreaterThanOrEqual(40000);
    expect(p).toBeLessThanOrEqual(49999);
    defaultPool.release(p);
  });
});
