import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createShellSessionReaper } from "../../packages/gateway/src/shell/reaper.js";

const DAY = 24 * 60 * 60 * 1000;

function session(input: {
  name: string;
  status: "active" | "exited";
  ageMs: number;
  kind?: string;
}) {
  const stamp = new Date(Date.now() - input.ageMs).toISOString();
  return {
    name: input.name,
    status: input.status,
    createdAt: stamp,
    updatedAt: stamp,
    ...(input.kind ? { kind: input.kind } : {}),
  };
}

describe("shell session reaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaps only kind-tagged exited sessions older than the TTL", async () => {
    const deleted: string[] = [];
    const registry = {
      list: vi.fn(async () => [
        session({ name: "old-tagged", status: "exited", ageMs: 8 * DAY, kind: "session" }),
        session({ name: "fresh-tagged", status: "exited", ageMs: 2 * DAY, kind: "session" }),
        session({ name: "old-legacy", status: "exited", ageMs: 30 * DAY }),
        session({ name: "old-active", status: "active", ageMs: 30 * DAY, kind: "session" }),
      ]),
      delete: vi.fn(async (name: string) => {
        deleted.push(name);
      }),
    };
    const reaper = createShellSessionReaper({ registry, ttlMs: 7 * DAY });

    await reaper.sweep();

    expect(deleted).toEqual(["old-tagged"]);
  });

  it("continues past per-session delete failures", async () => {
    const deleted: string[] = [];
    const registry = {
      list: vi.fn(async () => [
        session({ name: "broken", status: "exited", ageMs: 9 * DAY, kind: "session" }),
        session({ name: "ok", status: "exited", ageMs: 9 * DAY, kind: "session" }),
      ]),
      delete: vi.fn(async (name: string) => {
        if (name === "broken") {
          throw new Error("zellij unavailable");
        }
        deleted.push(name);
      }),
    };
    const reaper = createShellSessionReaper({ registry, ttlMs: 7 * DAY });

    await expect(reaper.sweep()).resolves.toBeUndefined();
    expect(deleted).toEqual(["ok"]);
  });

  it("runs on an interval after start and stops cleanly", async () => {
    const registry = {
      list: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
    };
    const reaper = createShellSessionReaper({ registry, ttlMs: 7 * DAY, intervalMs: 1_000 });

    reaper.start();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(registry.list.mock.calls.length).toBeGreaterThanOrEqual(3);

    reaper.stop();
    const calls = registry.list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(registry.list.mock.calls.length).toBe(calls);
  });
});
