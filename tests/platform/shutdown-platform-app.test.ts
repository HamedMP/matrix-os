import { describe, expect, it, vi } from "vitest";
import { shutdownPlatformApp } from "../../packages/platform/src/shutdown-platform-app.js";

describe("platform application shutdown", () => {
  it("drains browser authority before telemetry", async () => {
    const calls: string[] = [];
    await shutdownPlatformApp({
      shutdownBrowserApprovals: async () => { calls.push("browser"); },
      shutdownPostHog: async () => { calls.push("telemetry"); },
    });
    expect(calls).toEqual(["browser", "telemetry"]);
  });

  it("still drains telemetry when browser shutdown fails", async () => {
    const failure = new Error("synthetic browser shutdown failure");
    const shutdownPostHog = vi.fn(async () => {});
    await expect(shutdownPlatformApp({
      shutdownBrowserApprovals: async () => { throw failure; }, shutdownPostHog,
    })).rejects.toBe(failure);
    expect(shutdownPostHog).toHaveBeenCalledOnce();
  });

  it("drains telemetry when browser authority is disabled and propagates telemetry failure", async () => {
    const failure = new Error("synthetic telemetry failure");
    const shutdownPostHog = vi.fn(async () => { throw failure; });
    await expect(shutdownPlatformApp({ shutdownPostHog })).rejects.toBe(failure);
    expect(shutdownPostHog).toHaveBeenCalledOnce();
  });
});

it("closes the qualified Google runtime before shared infrastructure and still closes telemetry on failure", async () => {
 const calls: string[] = [];
 const app = {shutdownBrowserApprovals: async () => { calls.push("browser"); }, shutdownPostHog: async () => { calls.push("telemetry"); }};
 await shutdownPlatformApp(app, {close: async () => { calls.push("qualified"); }});
 expect(calls).toEqual(["qualified", "browser", "telemetry"]);
 calls.length = 0;
 await expect(shutdownPlatformApp(app, {close: async () => { calls.push("qualified"); throw new Error("fixture close"); }})).rejects.toThrow("fixture close");
 expect(calls).toEqual(["qualified", "browser", "telemetry"]);
});
