// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityMonitorApp } from "../../shell/src/components/system-activity/ActivityMonitorApp.js";
import { useSystemActivityStore, type ActivitySnapshot } from "../../shell/src/stores/systemActivityStore.js";
import { isBuiltInAppPath, normalizeBuiltInAppPath } from "../../shell/src/lib/builtin-apps.js";

const snapshot: ActivitySnapshot = {
  generatedAt: "2026-06-07T17:30:00.000Z",
  machine: {
    handle: "hamedmp",
    runtimeSlot: "primary",
    hostname: "matrix-hamedmp-bdbdbbb5",
    status: "healthy",
    releaseVersion: "v2026.06.07-316",
    releaseChannel: "dev",
    gitCommit: "e7e2ef8",
    uptimeSeconds: 7200,
  },
  resources: {
    cpu: { cores: 2, load1: 0.5, load5: 0.2, load15: 0.1, pressureSome10: 0 },
    memory: {
      totalBytes: 4_000_000_000,
      usedBytes: 2_000_000_000,
      availableBytes: 2_000_000_000,
      processRssBytes: 600_000_000,
      cgroupAnonBytes: 200_000_000,
      cgroupFileBytes: 100_000_000,
      cgroupKernelBytes: 10_000_000,
    },
    swap: { totalBytes: 0, usedBytes: 0 },
    disk: [{ mount: "/", label: "System", usedBytes: 80, totalBytes: 100, usedPercent: 80 }],
  },
  services: [
    { serviceId: "matrix-gateway", state: "running", memoryBytes: 380_000_000, cpuSeconds: 815, tasks: 79 },
  ],
  processes: [
    {
      processRef: "proc_1",
      pid: 101,
      ownerClass: "matrix",
      classification: "matrix_service",
      displayName: "matrix-gateway",
      cpuPercent: 2,
      rssBytes: 380_000_000,
      elapsedSeconds: 3600,
      ports: [4000],
    },
  ],
  cleanupSuggestions: [
    {
      candidateId: "cand_1",
      type: "stop_stale_app_server",
      targetLabel: "Next.js app server",
      reason: "No active connections and the app server appears stale.",
      confidence: "high",
      risk: "high",
      estimatedReclaimBytes: 100_000_000,
      requiresConfirmation: true,
      confirmationToken: "confirm_1",
      expiresAt: "2026-06-07T17:35:00.000Z",
    },
  ],
  collectionWarnings: [],
};

describe("ActivityMonitorApp", () => {
  beforeEach(() => {
    vi.useRealTimers();
    useSystemActivityStore.setState({
      snapshot: null,
      refreshStatus: "idle",
      cleanupStatus: "idle",
      error: null,
      cleanupMessage: null,
    });
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/system/activity/actions")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          candidateId: "cand_1",
          confirmationToken: "confirm_1",
          mode: "manual",
        });
        return new Response(JSON.stringify({ message: "Cleanup completed." }), { status: 200 });
      }
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }) as typeof fetch;
  });

  it("treats Activity Monitor as a built-in app path", () => {
    expect(normalizeBuiltInAppPath("activity-monitor")).toBe("__activity-monitor__");
    expect(isBuiltInAppPath("__activity-monitor__")).toBe(true);
  });

  it("renders machine, resources, services, processes, and cleanup actions", async () => {
    render(<ActivityMonitorApp />);

    await screen.findByText("matrix-hamedmp-bdbdbbb5");
    expect(screen.getByText("v2026.06.07-316")).toBeTruthy();
    expect(screen.getAllByText("matrix-gateway").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Top Processes")).toBeTruthy();
    expect(screen.getByText("Next.js app server")).toBeTruthy();
    expect(screen.getByText("high risk").className).toContain("bg-red-100");

    fireEvent.click(screen.getByRole("button", { name: "Clean" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/system/activity/actions"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("renders cleanup failures as danger feedback", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/system/activity/actions")) {
        return new Response(JSON.stringify({ error: { message: "Request failed" } }), { status: 500 });
      }
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }) as typeof fetch;

    render(<ActivityMonitorApp />);

    await screen.findByText("matrix-hamedmp-bdbdbbb5");
    fireEvent.click(screen.getByRole("button", { name: "Clean" }));

    const message = await screen.findByText("Cleanup could not be completed.");
    expect(message.className).toContain("bg-red-50");
  });

  it("guards concurrent cleanup submissions in the store", async () => {
    useSystemActivityStore.setState({ snapshot, cleanupStatus: "idle", cleanupMessage: null });
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/system/activity/actions")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(JSON.stringify({ message: "Cleanup completed." }), { status: 200 });
      }
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }) as typeof fetch;

    await Promise.all([
      useSystemActivityStore.getState().runCleanup("cand_1"),
      useSystemActivityStore.getState().runCleanup("cand_1"),
    ]);

    const cleanupCalls = vi.mocked(global.fetch).mock.calls.filter(([input]) => String(input).includes("/api/system/activity/actions"));
    expect(cleanupCalls).toHaveLength(1);
  });
});
