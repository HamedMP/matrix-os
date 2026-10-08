import { expect, it, vi } from "vitest";
import { createCatalogReadinessCache } from "../../packages/gateway/src/chat/catalog-readiness-cache.js";

it("evicts pending owners and prevents their late reads restoring stale readiness", async () => {
  const cache = createCatalogReadinessCache({ ttlMs: 60_000, now: () => 0, usable: () => true });
  let release!: (value: string) => void;
  const stale = cache.get("owner_0", () => new Promise<string>(resolve => { release = resolve; }));
  const other = Array.from({ length: 64 }, (_, i) => cache.get(`owner_${i + 1}`, async () => "ready"));
  await Promise.all(other);
  release("stale");
  await expect(stale).resolves.toBe("stale");
  const fresh = vi.fn(async () => "fresh");
  await expect(cache.get("owner_0", fresh)).resolves.toBe("fresh");
  expect(fresh).toHaveBeenCalledOnce();
});

it("expires unavailable readiness quickly and bounds positive reuse at sixty seconds", async () => {
  let now = 0;
  const read = vi.fn(async () => false);
  const cache = createCatalogReadinessCache({ ttlMs: 500_000, now: () => now, usable: value => value });
  await cache.get("owner", read);
  now = 1_999;
  await cache.get("owner", read);
  expect(read).toHaveBeenCalledOnce();
  now = 2_000;
  read.mockResolvedValue(true);
  await cache.get("owner", read);
  now = 62_000;
  await cache.get("owner", read);
  expect(read).toHaveBeenCalledTimes(3);
});

it("disabled reuse never shares a pending read or retains a result", async () => {
  const cache = createCatalogReadinessCache({ ttlMs: 0, now: () => 0, usable: () => true });
  const read = vi.fn(async () => "ready");
  await Promise.all([cache.get("owner", read), cache.get("owner", read)]);
  await cache.get("owner", read);
  expect(read).toHaveBeenCalledTimes(3);
});
