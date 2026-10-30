// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RuntimeCompatibilityGate from "@renderer/features/updates/RuntimeCompatibilityGate";
import { useConnection } from "@renderer/stores/connection";
import { useUi } from "@renderer/stores/ui";
import type { ApiClient } from "@renderer/lib/api";
import hostInfo from "../fixtures/host-release-system-info.json";

const desktopCommit = "5a33ceb47fcdd035c95d8dfedf0cd02a5209106b";
const cloudCommit = "df546d9ee2f371ac3755550fcaed0bdd53897970";
const info = {
  version: "v2026.09.09-1199", runningVersion: "v2026.09.09-1199",
  build: { sha: cloudCommit },
  runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: 1, maxDesktopProtocol: 1 },
};

beforeEach(() => {
  vi.stubGlobal("operator", { invoke: vi.fn(async (channel: string) => {
    if (channel === "app:get-version") return {
      version: "0.1.0-canary.20260910044841",
      source: { commit: desktopCommit, ancestors: [cloudCommit] },
    };
    if (channel === "update:check") return { status: "up-to-date" };
    return { ok: true };
  }) });
  useUi.setState({ rendererOverlayCount: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("released Desktop and cloud content alignment", () => {
  it("keeps the workspace visible when both channels are current despite different source commits", async () => {
    const get = vi.fn(async (path: string) => path === "/api/system/update"
      ? { channel: "dev", latest: { version: info.version }, updateAvailable: false }
      : info);
    useConnection.setState({ api: { get, forRuntime() { return this; } } as unknown as ApiClient });
    render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/system/update", expect.anything()));
    expect(screen.queryByRole("dialog", { name: "Update Matrix OS" })).toBeNull();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(useUi.getState().rendererOverlayCount).toBe(0);
  });
  it("prompts when an update appears later for the same release pair", async () => {
    let updateAvailable = false;
    const get = vi.fn(async (path: string) => path === "/api/system/update"
      ? { channel: "dev", latest: { version: updateAvailable ? "v2026.09.10-1205" : info.version }, updateAvailable }
      : info);
    useConnection.setState({ api: { get, forRuntime() { return this; } } as unknown as ApiClient });
    render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path === "/api/system/update")).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Update Matrix OS" })).toBeNull();
    updateAvailable = true;
    act(() => window.dispatchEvent(new Event("matrix:runtime-reconnected")));
    expect(await screen.findByRole("dialog", { name: "Update Matrix OS" })).toBeTruthy();
  });
  it("does not reuse an actionable plan for a newer release pair with no available update", async () => {
    let currentInfo = info;
    let updateAvailable = true;
    const get = vi.fn(async (path: string) => path === "/api/system/update"
      ? { channel: "dev", latest: { version: updateAvailable ? "v2026.09.10-1205" : info.version }, updateAvailable }
      : currentInfo);
    useConnection.setState({ api: { get, forRuntime() { return this; } } as unknown as ApiClient });
    render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
    await screen.findByRole("dialog", { name: "Update Matrix OS" });
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    currentInfo = { ...info, build: { sha: "d".repeat(40) } };
    updateAvailable = false;
    act(() => window.dispatchEvent(new Event("matrix:runtime-reconnected")));
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path === "/api/system/update")).toHaveLength(2));
    expect(screen.queryByRole("dialog", { name: "Update Matrix OS" })).toBeNull();
  });
  it("checks a newer release pair even when the previous channel check is still pending", async () => {
    let currentInfo = info;
    let finishFirstCheck!: (value: unknown) => void;
    let checks = 0;
    const get = vi.fn(async (path: string) => {
      if (path === "/api/system/info") return currentInfo;
      if (++checks === 1) return new Promise((resolve) => { finishFirstCheck = resolve; });
      return { channel: "dev", latest: { version: "v2026.09.10-1205" }, updateAvailable: true };
    });
    useConnection.setState({ api: { get, forRuntime() { return this; } } as unknown as ApiClient });
    render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
    await waitFor(() => expect(checks).toBe(1));
    currentInfo = { ...info, build: { sha: "d".repeat(40) } };
    act(() => window.dispatchEvent(new Event("matrix:runtime-reconnected")));
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path === "/api/system/info")).toHaveLength(3));
    await waitFor(() => expect(checks).toBe(2));
    await act(async () => finishFirstCheck({ channel: "dev", latest: { version: info.version }, updateAvailable: false }));
    expect(await screen.findByRole("dialog", { name: "Update Matrix OS" })).toBeTruthy();
  });
  it("waits for an in-flight desktop update check when reconnecting to a newer release pair", async () => {
    let finishDesktopCheck!: (value: unknown) => void;
    let desktopChecks = 0;
    vi.stubGlobal("operator", { invoke: vi.fn(async (channel: string) => {
      if (channel === "app:get-version") return { version: "0.1.0", source: { commit: desktopCommit, ancestors: [cloudCommit] } };
      if (channel === "update:check") {
        if (++desktopChecks === 1) return new Promise((resolve) => { finishDesktopCheck = resolve; });
        return { status: "checking" };
      }
      return { ok: true };
    }) });
    let currentInfo = info;
    const get = vi.fn(async (path: string) => path === "/api/system/update"
      ? { channel: "dev", latest: { version: info.version }, updateAvailable: false }
      : currentInfo);
    useConnection.setState({ api: { get, forRuntime() { return this; } } as unknown as ApiClient });
    render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
    await waitFor(() => expect(desktopChecks).toBe(1));
    currentInfo = { ...info, build: { sha: "d".repeat(40) } };
    act(() => window.dispatchEvent(new Event("matrix:runtime-reconnected")));
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path === "/api/system/info")).toHaveLength(4));
    await act(async () => finishDesktopCheck({ status: "ready", version: "0.2.0", release: { version: "0.2.0", notes: "Fix" } }));
    expect(await screen.findByRole("button", { name: "Update & restart" })).toBeTruthy();
    expect(desktopChecks).toBe(1);
  });
  it("opens the real gate for a VPS response whose build sha is unknown", async () => {
    vi.stubGlobal("operator", { invoke: vi.fn(async (channel: string) => {
      if (channel === "app:get-version") return { version: "0.1.0",
        source: { commit: "b".repeat(40), ancestors: [hostInfo.release.gitCommit] } };
      if (channel === "update:check") return { status: "up-to-date", channel: "canary" };
      return { ok: true };
    }) });
    const api = { get: vi.fn(async (path: string) => path === "/api/system/update"
      ? { channel: "dev", updateAvailable: true, latest: { version: "v2026.09.10-1209" } }
      : hostInfo), forRuntime() { return this; } } as unknown as ApiClient;
    useConnection.setState({ api });
    render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
    expect(await screen.findByRole("dialog", { name: "Update Matrix OS" })).toBeTruthy();
  });
  it("keeps explicit protocol recovery visible when local provenance is unavailable", async () => {
    vi.stubGlobal("operator", { invoke: vi.fn(async (channel: string) => {
      if (channel === "app:get-version") return { version: "0.1.0", source: null };
      if (channel === "update:check") return { status: "up-to-date" };
      return { ok: true };
    }) });
    const get = vi.fn(async (path: string) => path === "/api/system/update"
      ? { channel: "dev", latest: { version: "v2026.09.10-1205" }, updateAvailable: true }
      : { ...info, runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: 2, maxDesktopProtocol: 2 } });
    const api = { get, forRuntime() { return this; } } as unknown as ApiClient;
    useConnection.setState({ api });
    render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
    expect(await screen.findByRole("dialog", { name: "Update Matrix OS" })).toBeTruthy();
    expect(await screen.findByText(/desktop app must be updated/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update", exact: true })).toBeNull();
  });

  it("prompts for missing released changes even when both sides declare protocol 1", async () => {
    const get = vi.fn(async (path: string) => path === "/api/system/update"
      ? { channel: "dev", latest: { version: "v2026.09.10-1205" }, updateAvailable: true }
      : info);
    const api = { get, forRuntime() { return this; } } as unknown as ApiClient;
    useConnection.setState({ api });
    render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
    expect(await screen.findByRole("dialog", { name: "Update Matrix OS" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Update" })).toBeTruthy();
  });
});
