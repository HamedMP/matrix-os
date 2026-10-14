// @vitest-environment jsdom
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const get = vi.fn(async (_path: string): Promise<unknown> => undefined);
  return {
    info: {} as Record<string, unknown>,
    snapshot: {} as Record<string, unknown>,
    refresh: vi.fn(async () => undefined),
    get,
    api: { get },
  };
});

describe("ENG-288 capacity-based resource monitoring", () => {
  beforeEach(() => {
    Object.assign(state, fixtures({ visibleLogicalCpuCount: 8, effectiveCpuCapacity: 1.5, constraintStatus: "complete" }));
  });

  it("normalizes Resource Manager load against fractional effective capacity", async () => {
    const { container } = render(<ResourceManager />);
    await waitFor(() => expect(container.textContent).toContain("1.00 load"));
    const bar = container.querySelector<HTMLElement>('[aria-label="CPU usage"] .bar');
    expect(bar?.style.width).toBe("67%");
  });

  it("normalizes Web Activity Monitor load against the same effective capacity", () => {
    const { container } = render(<ActivityMonitorApp />);
    expect(container.textContent).toContain("67%");
  });
});
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({
  useConnection: (selector: (value: unknown) => unknown) => selector({ api: state.api, runtimeSlot: "staging" }),
}));
vi.mock("../../desktop/src/renderer/src/stores/runtime-generation", () => ({
  captureRuntimeGeneration: () => 1,
  isCurrentRuntimeGeneration: () => true,
}));
vi.mock("@/stores/systemActivityStore", () => ({
  useSystemActivityStore: (selector: (value: unknown) => unknown) => selector({
    snapshot: state.snapshot, refreshStatus: "success", cleanupStatus: "idle",
    error: null, cleanupMessage: null, refresh: state.refresh, runCleanup: vi.fn(),
  }),
}));
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "http://gateway.test" }));

import SystemSection from "../../desktop/src/renderer/src/features/settings/sections/SystemSection.js";
import ResourceManager from "../../home/apps/resource-manager/src/App.js";
import { ActivityMonitorApp } from "../../shell/src/components/system-activity/ActivityMonitorApp.js";
import { RuntimeIdentityBanner } from "../../shell/src/components/RuntimeIdentityBanner.js";

type Capacity = {
  visibleLogicalCpuCount: number;
  effectiveCpuCapacity: number | null;
  constraintStatus: "complete" | "unavailable";
};

function fixtures(capacity?: Capacity) {
  return {
    info: {
      version: "v2026.10.14-1", runningVersion: "v2026.10.14-1",
      runtime: { handle: "cpu-fixture", runtimeSlot: "staging", machineId: "11111111-1111-4111-8111-111111111111" },
      resources: { cpuCount: 8, ...(capacity ? { cpuCapacity: capacity } : {}) },
      release: { version: "v2026.10.14-1", channel: "dev" },
    },
    snapshot: {
      generatedAt: "2026-10-14T12:00:00Z",
      machine: { handle: "cpu-fixture", runtimeSlot: "staging", hostname: "cpu-fixture", status: "healthy", uptimeSeconds: 1 },
      resources: {
        cpu: { cores: 8, load1: 1, load5: 0, load15: 0, ...(capacity ? { capacity } : {}) },
        memory: { totalBytes: 1024, usedBytes: 0, availableBytes: 1024, processRssBytes: 0 },
        swap: { totalBytes: 0, usedBytes: 0 }, disk: [],
      },
      services: [], processes: [], cleanupSuggestions: [], collectionWarnings: [],
    },
  };
}

beforeEach(() => {
  state.get.mockImplementation(async (path) => path === "/api/system/info" ? state.info : { releases: [], latest: null });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => String(input).endsWith("/api/system/info") ? state.info : { handle: "cpu-fixture" },
  })));
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: {
    gatewayFetch: vi.fn(async () => state.snapshot),
  } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "MatrixOS");
});

const surfaces = [
  ["Electron System", SystemSection],
  ["Resource Manager", ResourceManager],
  ["Web Activity Monitor", ActivityMonitorApp],
  ["Web runtime banner", RuntimeIdentityBanner],
] as const;

describe.each(surfaces)("ENG-288 %s vocabulary", (_name, Surface) => {
  it.each([4, 1.5, 0.5])("distinguishes %s effective vCPUs from eight visible logical CPUs", async (effective) => {
    Object.assign(state, fixtures({ visibleLogicalCpuCount: 8, effectiveCpuCapacity: effective, constraintStatus: "complete" }));
    const { container } = render(<Surface />);
    await waitFor(() => expect(container.textContent).toContain("8"));
    expect(container.textContent).toContain(`${effective} effective vCPUs`);
    expect(container.textContent).toContain("8 visible logical CPUs");
    expect(container.textContent).not.toMatch(/8 cores|8 CPU\b/);
  });

  it.each([
    ["unreadable constraints", { visibleLogicalCpuCount: 8, effectiveCpuCapacity: null, constraintStatus: "unavailable" }],
    ["older gateway without capacity provenance", undefined],
  ] satisfies Array<[string, Capacity | undefined]>)("does not infer effective capacity for %s", async (_scenario, capacity) => {
    Object.assign(state, fixtures(capacity));
    const { container } = render(<Surface />);
    await waitFor(() => expect(container.textContent).toContain("8"));
    expect(container.textContent).toContain("8 visible logical CPUs");
    expect(container.textContent).toContain("Effective CPU capacity unknown");
    expect(container.textContent).not.toMatch(/8 effective vCPUs|8 cores|8 CPU\b/);
  });
});
