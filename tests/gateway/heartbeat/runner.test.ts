import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createHeartbeatRunner,
  type HeartbeatRunner,
} from "../../../packages/gateway/src/heartbeat/runner.js";
import { buildHeartbeatPrompt } from "../../../packages/gateway/src/heartbeat/prompt.js";
import type { Dispatcher } from "../../../packages/gateway/src/dispatcher.js";
import type { CronJob } from "../../../packages/gateway/src/cron/types.js";
import type { KernelEvent } from "@matrix-os/kernel";

function tmpHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "heartbeat-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  return dir;
}

function mockDispatcher(): Dispatcher {
  return {
    dispatch: vi.fn(async (_msg, _sid, onEvent) => {
      onEvent({ type: "text", text: "HEARTBEAT_OK" } as KernelEvent);
    }),
    dispatchBatch: vi.fn(async () => []),
    queueLength: 0,
    activeCount: 0,
    db: {} as any,
    homePath: "",
  };
}

describe("T120c: Heartbeat runner", () => {
  let homePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    homePath = tmpHome();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(homePath, { recursive: true, force: true });
  });

  it("invokes dispatcher on interval", async () => {
    const dispatcher = mockDispatcher();
    const runner = createHeartbeatRunner({
      homePath,
      dispatcher,
      everyMinutes: 1,
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatcher.dispatch).toHaveBeenCalled();
    runner.stop();
  });

  it("skips when outside active hours", async () => {
    const dispatcher = mockDispatcher();
    const now = new Date();
    const pastHour = (now.getHours() + 22) % 24;
    const pastEnd = (now.getHours() + 23) % 24;

    const runner = createHeartbeatRunner({
      homePath,
      dispatcher,
      activeHours: {
        start: `${String(pastHour).padStart(2, "0")}:00`,
        end: `${String(pastEnd).padStart(2, "0")}:00`,
      },
    });

    await runner.runOnce();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("runs when within active hours", async () => {
    const dispatcher = mockDispatcher();
    const now = new Date();
    const startHour = now.getHours();
    const endHour = (now.getHours() + 2) % 24;

    const runner = createHeartbeatRunner({
      homePath,
      dispatcher,
      activeHours: {
        start: `${String(startHour).padStart(2, "0")}:00`,
        end: `${String(endHour).padStart(2, "0")}:00`,
      },
    });

    await runner.runOnce();
    expect(dispatcher.dispatch).toHaveBeenCalled();
  });

  it("stop() clears interval", () => {
    const dispatcher = mockDispatcher();
    const runner = createHeartbeatRunner({
      homePath,
      dispatcher,
      everyMinutes: 1,
    });

    runner.start();
    runner.stop();
    vi.advanceTimersByTime(120_000);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe("Heartbeat prompt builder", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = tmpHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("includes heartbeat.md content", () => {
    writeFileSync(join(homePath, "agents", "heartbeat.md"), "# Check modules");
    const prompt = buildHeartbeatPrompt(homePath, []);
    expect(prompt).toContain("Check modules");
  });

  it("includes pending cron events", () => {
    const events: CronJob[] = [
      {
        id: "j1",
        name: "water-reminder",
        message: "Time to drink water!",
        schedule: { type: "interval", intervalMs: 7200000 },
        target: { channel: "telegram", chatId: "123" },
        createdAt: new Date().toISOString(),
      },
    ];

    const prompt = buildHeartbeatPrompt(homePath, events);
    expect(prompt).toContain("water-reminder");
    expect(prompt).toContain("Time to drink water!");
    expect(prompt).toContain("telegram");
  });

  it("includes HEARTBEAT_OK instruction", () => {
    const prompt = buildHeartbeatPrompt(homePath, []);
    expect(prompt).toContain("HEARTBEAT_OK");
  });

  it("includes current time", () => {
    const prompt = buildHeartbeatPrompt(homePath, []);
    expect(prompt).toContain("[HEARTBEAT]");
    expect(prompt).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("handles missing heartbeat.md gracefully", () => {
    const prompt = buildHeartbeatPrompt(homePath, []);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
