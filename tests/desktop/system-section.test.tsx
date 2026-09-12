// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopUpdateButton from "../../desktop/src/renderer/src/features/updates/DesktopUpdateButton";
import { useDesktopUpdate } from "../../desktop/src/renderer/src/stores/desktop-update";
import SystemSection from "../../desktop/src/renderer/src/features/settings/sections/SystemSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { advanceRuntimeGeneration } from "../../desktop/src/renderer/src/stores/runtime-generation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function makeApi() {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path === "/api/system/info") {
        return { version: "0.1.0", updateChannel: "stable", release: { version: "v2026.08.20", channel: "stable" } };
      }
      if (path === "/api/system/update?channel=stable") {
        return { channel: "stable", latest: { version: "v2026.08.28", channel: "stable" }, updateAvailable: true };
      }
      if (path === "/api/system/releases?channel=stable") {
        return {
          channel: "stable",
          generatedAt: "2026-08-28T00:00:00.000Z",
          releases: [
            { version: "v2026.08.28", channel: "stable", gitCommit: "0123456789abcdef", changelog: "Bug fixes" },
            { version: "v2026.08.10", channel: "stable", gitCommit: "fedcba9876543210", changelog: "Earlier release" },
          ],
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ ok: true, status: "started", version: "v2026.08.28" })),
    getText: vi.fn(),
    getBlob: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  };
}

describe("Electron Desktop read-only cloud system info", () => {
  beforeEach(() => {
    useConnection.setState({ api: makeApi() as never, runtimeSlot: "primary" });
    useDesktopUpdate.setState({ snapshot: { status: "disabled" }, installing: false, manualDialogOpen: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("removes cloud release selection, upgrade and downgrade controls even when updates exist", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    render(<React.StrictMode><SystemSection /></React.StrictMode>);

    await screen.findAllByText("v2026.08.20");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /upgrade|downgrade|install|refresh releases/i })).toBeNull();
    expect(screen.queryByText("Choose a release channel or install a specific version.")).toBeNull();
    expect(api.get.mock.calls.every(([path]) => path === "/api/system/info")).toBe(true);
    for (const mutation of [api.post, api.put, api.patch, api.delete]) expect(mutation).not.toHaveBeenCalled();
  });

  it("preserves installed and running versions, artifact channel, read-only update subscription and machine resources", async () => {
    const api = makeApi();
    api.get.mockResolvedValue({
      version: "v2026.08.20", runningVersion: "v2026.08.19",
      release: { version: "v2026.08.20", channel: "dev" }, updateChannel: "stable",
      runtime: { machineId: "test-machine" },
      resources: { cpuCount: 4, memoryFree: 2 * 1024 ** 3, memoryTotal: 8 * 1024 ** 3, diskFree: 20 * 1024 ** 3, diskTotal: 80 * 1024 ** 3 },
    } as never);
    useConnection.setState({ api: api as never });
    render(<SystemSection />);
    for (const text of ["v2026.08.20", "v2026.08.19", "dev", "Update channel", "stable", "test-machine", "4", "2.0 GB of 8.0 GB", "20.0 GB of 80.0 GB"]) {
      expect(await screen.findAllByText(text)).not.toBeNull();
    }
    expect(screen.getByRole("status").textContent).toContain("do not match");
  });

  it("clears info when disconnected and ignores a previous runtime response", async () => {
    const pending = deferred<unknown>();
    const api = { ...makeApi(), get: vi.fn(() => pending.promise) };
    useConnection.setState({ api: api as never });
    render(<SystemSection />);
    await act(async () => {
      advanceRuntimeGeneration();
      useConnection.setState({ api: null, runtimeSlot: "review" });
    });
    await act(async () => {
      pending.resolve({ release: { version: "old-runtime", channel: "canary" } });
    });
    expect(screen.queryByText("old-runtime")).toBeNull();
  });

  it("shows a safe error if read-only runtime info is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = makeApi();
    api.get.mockRejectedValue(new Error("private upstream failure"));
    useConnection.setState({ api: api as never });
    render(<SystemSection />);
    expect(await screen.findByText("System info unavailable.")).not.toBeNull();
    expect(screen.queryByText("private upstream failure")).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("keeps local Desktop OTA checking and installation functional without cloud mutations", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    const invoke = vi.fn(async (channel: string) => channel === "update:check"
      ? { status: "ready", version: "1.2.3" }
      : { ok: true });
    vi.stubGlobal("operator", { invoke });
    render(<><SystemSection /><DesktopUpdateButton /></>);
    await screen.findAllByText("v2026.08.20");
    await act(async () => { await useDesktopUpdate.getState().check(); });
    expect(invoke).toHaveBeenCalledWith("update:check", {});
    fireEvent.click(screen.getByRole("button", { name: "Update Matrix OS to 1.2.3" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("update:install", {}));
    expect(api.get.mock.calls.every(([path]) => path === "/api/system/info")).toBe(true);
    for (const mutation of [api.post, api.put, api.patch, api.delete]) expect(mutation).not.toHaveBeenCalled();
  });
});
