import { describe, expect, it } from "vitest";
import { createTerminalLeaseCoordinator } from "../../packages/gateway/src/shell/terminal-lease.js";

describe("terminal live lease coordinator", () => {
  it("transfers the sole live lease and invalidates the former holder", () => {
    const leases = createTerminalLeaseCoordinator({ now: () => 1_000 });

    const desktop = leases.acquire("main", "desktop", { cols: 180, rows: 50 });
    const vps = leases.acquire("main", "vps-cli", { cols: 80, rows: 24 });

    expect(desktop.epoch).toBe(1);
    expect(vps.epoch).toBe(2);
    expect(vps.revoked).toEqual({ holderId: "desktop", epoch: 1 });
    expect(leases.holds("main", "desktop", desktop.epoch)).toBe(false);
    expect(leases.holds("main", "vps-cli", vps.epoch)).toBe(true);
    expect(leases.current("main")).toEqual({
      holderId: "vps-cli",
      epoch: 2,
      size: { cols: 80, rows: 24 },
    });
  });

  it("does not let a stale holder release or resize a newer lease", () => {
    const leases = createTerminalLeaseCoordinator({ now: () => 1_000 });
    const desktop = leases.acquire("main", "desktop", { cols: 180, rows: 50 });
    const vps = leases.acquire("main", "vps-cli", { cols: 80, rows: 24 });

    expect(leases.resize("main", "desktop", desktop.epoch, { cols: 200, rows: 60 })).toBeNull();
    expect(leases.release("main", "desktop", desktop.epoch)).toBe(false);
    expect(leases.resize("main", "vps-cli", vps.epoch, { cols: 90, rows: 30 })).toEqual({
      holderId: "vps-cli",
      epoch: 2,
      size: { cols: 90, rows: 30 },
    });
  });

  it("expires an abandoned lease before granting the next holder", () => {
    let now = 1_000;
    const leases = createTerminalLeaseCoordinator({ now: () => now, ttlMs: 100 });
    const desktop = leases.acquire("main", "desktop", { cols: 180, rows: 50 });
    now += 101;

    const vps = leases.acquire("main", "vps-cli", { cols: 80, rows: 24 });

    expect(vps.revoked).toBeUndefined();
    expect(leases.holds("main", "desktop", desktop.epoch)).toBe(false);
    expect(vps.epoch).toBe(2);
  });

  it("does not revive a holder after its lease already expired", () => {
    let now = 1_000;
    const leases = createTerminalLeaseCoordinator({ now: () => now, ttlMs: 100 });
    const desktop = leases.acquire("main", "desktop", { cols: 180, rows: 50 });
    now += 101;

    expect(leases.touch("main", "desktop", desktop.epoch)).toBe(false);
    expect(leases.holds("main", "desktop", desktop.epoch)).toBe(false);
  });

  it("renews a live holder before its lease expires", () => {
    let now = 1_000;
    const leases = createTerminalLeaseCoordinator({ now: () => now, ttlMs: 100 });
    const desktop = leases.acquire("main", "desktop", { cols: 180, rows: 50 });
    now += 75;

    expect(leases.touch("main", "desktop", desktop.epoch)).toBe(true);
    now += 75;
    expect(leases.holds("main", "desktop", desktop.epoch)).toBe(true);
  });
});
