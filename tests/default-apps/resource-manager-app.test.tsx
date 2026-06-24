// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/resource-manager/src/App.js";

declare global {
  interface Window {
    MatrixOS?: {
      gatewayFetch?: <T>(url: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;
    };
  }
}

function activitySnapshot() {
  return {
    generatedAt: "2026-06-24T12:00:00Z",
    machine: {
      handle: "hamedmp",
      runtimeSlot: "customer-vps",
      hostname: "matrix-hamedmp",
      status: "healthy",
      releaseVersion: "267",
      releaseChannel: "dev",
      uptimeSeconds: 93_600,
    },
    resources: {
      cpu: { cores: 4, load1: 1.25, load5: 0.8, load15: 0.5 },
      memory: {
        totalBytes: 8 * 1024 * 1024 * 1024,
        usedBytes: 3 * 1024 * 1024 * 1024,
        availableBytes: 5 * 1024 * 1024 * 1024,
        processRssBytes: 512 * 1024 * 1024,
      },
      swap: { totalBytes: 2 * 1024 * 1024 * 1024, usedBytes: 256 * 1024 * 1024 },
      disk: [
        { mount: "/", label: "root", usedBytes: 24 * 1024 * 1024 * 1024, totalBytes: 80 * 1024 * 1024 * 1024, usedPercent: 30 },
      ],
    },
    services: [
      { serviceId: "matrix-gateway", state: "running", memoryBytes: 220 * 1024 * 1024, restartCount: 0 },
      { serviceId: "matrix-shell", state: "running", memoryBytes: 310 * 1024 * 1024, restartCount: 1 },
      { serviceId: "matrix-code", state: "failed", memoryBytes: 0, restartCount: 3 },
    ],
    processes: [
      {
        processRef: "pid:4123",
        pid: 4123,
        ownerClass: "matrix",
        classification: "gateway",
        displayName: "matrix-gateway",
        cpuPercent: 12.5,
        rssBytes: 180 * 1024 * 1024,
        elapsedSeconds: 4200,
        ports: [3001],
      },
      {
        processRef: "pid:5333",
        pid: 5333,
        ownerClass: "matrix",
        classification: "app-server",
        displayName: "vite notes",
        cpuPercent: 3.1,
        rssBytes: 96 * 1024 * 1024,
        elapsedSeconds: 800,
        ports: [4173],
      },
    ],
    cleanupSuggestions: [
      {
        candidateId: "cache:old-bundle",
        type: "prune_old_bundle",
        targetLabel: "Old host bundle",
        reason: "Bundle is no longer active",
        confidence: "high",
        risk: "low",
        estimatedReclaimBytes: 1024 * 1024 * 1024,
        requiresConfirmation: true,
        confirmationToken: "confirm-1",
        expiresAt: "2026-06-24T13:00:00Z",
      },
    ],
    collectionWarnings: ["matrix-code is failed"],
  };
}

describe("Resource Manager app", () => {
  let calls: Array<{ url: string; init?: RequestInit; timeoutMs?: number }> = [];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Resource Manager must use the MatrixOS bridge");
    }));
    window.MatrixOS = {
      gatewayFetch: vi.fn(async (url: string, init?: RequestInit, timeoutMs?: number) => {
        calls.push({ url, init, timeoutMs });
        if (url === "/api/system/activity?processLimit=25&includeSuggestions=true") return activitySnapshot();
        return { ok: true };
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("imports its stylesheet so the Vite bundle ships CSS", () => {
    const entrypoint = readFileSync("home/apps/resource-manager/src/main.tsx", "utf8");

    expect(entrypoint).toMatch(/import ['"]\.\/styles\.css['"]/);
  });

  it("renders live system activity through the MatrixOS bridge", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("hamedmp")).toBeTruthy());

    expect(screen.getByText("Resource Manager")).toBeTruthy();
    expect(screen.getByText("healthy")).toBeTruthy();
    expect(screen.getByText("Release 267")).toBeTruthy();
    expect(screen.getByText("4 cores")).toBeTruthy();
    expect(screen.getByText("3 GB / 8 GB")).toBeTruthy();
    expect(screen.getByText("matrix-code")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("Old host bundle")).toBeTruthy();
    expect(screen.getByText("matrix-code is failed")).toBeTruthy();
    expect(calls).toEqual([
      {
        url: "/api/system/activity?processLimit=25&includeSuggestions=true",
        init: { method: "GET" },
        timeoutMs: 10_000,
      },
    ]);
  });

  it("refreshes without direct fetch and keeps bridge-only API access", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getAllByText("matrix-gateway").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls.length).toBe(2));

    const appSource = readFileSync("home/apps/resource-manager/src/App.tsx", "utf8");
    expect(appSource).toContain("window.MatrixOS.gatewayFetch");
    expect(appSource).toContain('"/api/system/activity?processLimit=25&includeSuggestions=true"');
    expect(appSource).toContain("matrix_bridge_unavailable");
    expect(appSource).not.toContain('fetch("/apps/resource-manager/api/snapshot"');
    expect(appSource).not.toContain("await fetch(");
  });
});
