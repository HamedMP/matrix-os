// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://gateway.test",
}));

import { SystemSection } from "../../shell/src/components/settings/sections/SystemSection.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe("SystemSection release refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ignores stale release metadata when the selected channel changes", async () => {
    const stableUpdate = deferred<Response>();
    const stableReleases = deferred<Response>();
    const devUpdate = deferred<Response>();
    const devReleases = deferred<Response>();

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          version: "v2026.05.14-1",
          release: {
            version: "v2026.05.14-1",
            channel: "stable",
            buildTime: "2026-05-14T11:00:00.000Z",
          },
        }));
      }
      if (url.endsWith("/health")) {
        return Promise.resolve(jsonResponse({ status: "ok", cronJobs: 0, channels: {} }));
      }
      if (url.endsWith("/api/system/update?channel=stable")) return stableUpdate.promise;
      if (url.endsWith("/api/system/releases?channel=stable")) return stableReleases.promise;
      if (url.endsWith("/api/system/update?channel=dev")) return devUpdate.promise;
      if (url.endsWith("/api/system/releases?channel=dev")) return devReleases.promise;
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SystemSection />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://gateway.test/api/system/update?channel=stable",
        expect.any(Object),
      );
    });

    fireEvent.change(screen.getByLabelText("Release channel"), {
      target: { value: "dev" },
    });

    await act(async () => {
      devUpdate.resolve(jsonResponse({
        channel: "dev",
        latest: {
          version: "main-abc1234-20260514130000",
          buildTime: "2026-05-14T13:00:00.000Z",
        },
        updateAvailable: true,
      }));
      devReleases.resolve(jsonResponse({
        channel: "dev",
        releases: [{
          version: "main-abc1234-20260514130000",
          buildTime: "2026-05-14T13:00:00.000Z",
        }],
      }));
    });

    await waitFor(() => {
      expect(screen.getByText("Latest dev release")).toBeTruthy();
      expect(screen.getAllByText("main-abc1234-20260514130000").length).toBeGreaterThan(0);
    });

    await act(async () => {
      stableUpdate.resolve(jsonResponse({
        channel: "stable",
        latest: {
          version: "v2026.05.14-2",
          buildTime: "2026-05-14T12:00:00.000Z",
        },
        updateAvailable: true,
      }));
      stableReleases.resolve(jsonResponse({
        channel: "stable",
        releases: [{
          version: "v2026.05.14-2",
          buildTime: "2026-05-14T12:00:00.000Z",
        }],
      }));
    });

    await waitFor(() => {
      expect(screen.getByText("Latest dev release")).toBeTruthy();
    });
    expect(screen.queryByText("Latest stable release")).toBeNull();
    expect(screen.queryByText("v2026.05.14-2")).toBeNull();
  });

  it("keeps showing install progress while a VPS update is still applying", async () => {
    let updateStarted = false;
    let infoPollsAfterUpdate = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        if (updateStarted) {
          infoPollsAfterUpdate += 1;
        }
        if (infoPollsAfterUpdate >= 4) {
          return Promise.resolve(jsonResponse({
            version: "v2026.05.28-151",
            release: {
              version: "v2026.05.28-151",
              channel: "stable",
              buildTime: "2026-05-28T19:53:18.421Z",
            },
          }));
        }
        return Promise.resolve(jsonResponse({
          version: "v2026.05.28-145",
          release: {
            version: "v2026.05.28-145",
            channel: "dev",
            buildTime: "2026-05-28T15:32:51.000Z",
          },
        }));
      }
      if (url.endsWith("/health")) {
        return Promise.resolve(jsonResponse({ status: "ok", cronJobs: 0, channels: {} }));
      }
      if (url.endsWith("/api/system/update?channel=dev")) {
        return Promise.resolve(jsonResponse({
          channel: "dev",
          latest: { version: "v2026.05.28-145" },
          updateAvailable: false,
        }));
      }
      if (url.endsWith("/api/system/releases?channel=dev")) {
        return Promise.resolve(jsonResponse({ channel: "dev", releases: [] }));
      }
      if (url.endsWith("/api/system/update?channel=stable")) {
        return Promise.resolve(jsonResponse({
          channel: "stable",
          latest: { version: "v2026.05.28-151" },
          updateAvailable: true,
        }));
      }
      if (url.endsWith("/api/system/releases?channel=stable")) {
        return Promise.resolve(jsonResponse({
          channel: "stable",
          releases: [{ version: "v2026.05.28-151", buildTime: "2026-05-28T19:53:18.421Z" }],
        }));
      }
      if (url.endsWith("/api/system/update") && init?.method === "POST") {
        updateStarted = true;
        return Promise.resolve(jsonResponse({ ok: true, status: "started", channel: "stable" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SystemSection />);

    await waitFor(() => {
      expect(screen.getByText("Installed channel")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("Release channel"), {
      target: { value: "stable" },
    });

    await waitFor(() => {
      expect(screen.getByText("Switch to stable")).toBeTruthy();
    });

    vi.useFakeTimers();
    fireEvent.click(screen.getByText("Switch to stable"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Installing... checking status")).toBeTruthy();
    expect(screen.getByText("Installing stable. This can take a few minutes...")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.getByText("Installing... checking status")).toBeTruthy();
    expect(screen.getByText("Installing stable. This can take a few minutes...")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText("Installed. Reloading...")).toBeTruthy();
  });

  it("accepts a channel switch when a newer release installs than the click-time latest", async () => {
    let updateStarted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        if (updateStarted) {
          return Promise.resolve(jsonResponse({
            version: "v2026.05.28-152",
            release: {
              version: "v2026.05.28-152",
              channel: "stable",
              buildTime: "2026-05-28T20:02:18.421Z",
            },
          }));
        }
        return Promise.resolve(jsonResponse({
          version: "v2026.05.28-145",
          release: {
            version: "v2026.05.28-145",
            channel: "dev",
            buildTime: "2026-05-28T15:32:51.000Z",
          },
        }));
      }
      if (url.endsWith("/health")) {
        return Promise.resolve(jsonResponse({ status: "ok", cronJobs: 0, channels: {} }));
      }
      if (url.endsWith("/api/system/update?channel=dev")) {
        return Promise.resolve(jsonResponse({
          channel: "dev",
          latest: { version: "v2026.05.28-145" },
          updateAvailable: false,
        }));
      }
      if (url.endsWith("/api/system/releases?channel=dev")) {
        return Promise.resolve(jsonResponse({ channel: "dev", releases: [] }));
      }
      if (url.endsWith("/api/system/update?channel=stable")) {
        return Promise.resolve(jsonResponse({
          channel: "stable",
          latest: { version: "v2026.05.28-151" },
          updateAvailable: true,
        }));
      }
      if (url.endsWith("/api/system/releases?channel=stable")) {
        return Promise.resolve(jsonResponse({
          channel: "stable",
          releases: [{ version: "v2026.05.28-151", buildTime: "2026-05-28T19:53:18.421Z" }],
        }));
      }
      if (url.endsWith("/api/system/update") && init?.method === "POST") {
        updateStarted = true;
        return Promise.resolve(jsonResponse({ ok: true, status: "started", channel: "stable" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SystemSection />);

    await waitFor(() => {
      expect(screen.getByText("Installed channel")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("Release channel"), {
      target: { value: "stable" },
    });

    await waitFor(() => {
      expect(screen.getByText("Switch to stable")).toBeTruthy();
    });

    vi.useFakeTimers();
    fireEvent.click(screen.getByText("Switch to stable"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText("Installed. Reloading...")).toBeTruthy();
    expect(screen.queryByText("Upgrade is still running. Check again in a minute.")).toBeNull();
  });

  it("re-enables update controls when install polling times out", async () => {
    let updateStarted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          version: "v2026.05.28-145",
          release: {
            version: "v2026.05.28-145",
            channel: "dev",
            buildTime: "2026-05-28T15:32:51.000Z",
          },
        }));
      }
      if (url.endsWith("/health")) {
        return Promise.resolve(jsonResponse({ status: "ok", cronJobs: 0, channels: {} }));
      }
      if (url.endsWith("/api/system/update?channel=dev")) {
        return Promise.resolve(jsonResponse({
          channel: "dev",
          latest: { version: "v2026.05.28-145" },
          updateAvailable: false,
        }));
      }
      if (url.endsWith("/api/system/releases?channel=dev")) {
        return Promise.resolve(jsonResponse({ channel: "dev", releases: [] }));
      }
      if (url.endsWith("/api/system/update?channel=stable")) {
        return Promise.resolve(jsonResponse({
          channel: "stable",
          latest: { version: "v2026.05.28-151" },
          updateAvailable: true,
        }));
      }
      if (url.endsWith("/api/system/releases?channel=stable")) {
        return Promise.resolve(jsonResponse({
          channel: "stable",
          releases: [{ version: "v2026.05.28-151", buildTime: "2026-05-28T19:53:18.421Z" }],
        }));
      }
      if (url.endsWith("/api/system/update") && init?.method === "POST") {
        updateStarted = true;
        return Promise.resolve(jsonResponse({ ok: true, status: "started", channel: "stable" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SystemSection />);

    await waitFor(() => {
      expect(screen.getByText("Installed channel")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("Release channel"), {
      target: { value: "stable" },
    });

    await waitFor(() => {
      expect(screen.getByText("Switch to stable")).toBeTruthy();
    });

    vi.useFakeTimers();
    fireEvent.click(screen.getByText("Switch to stable"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(305_000);
    });

    expect(updateStarted).toBe(true);
    expect(screen.getByText("Upgrade is still running. Check again in a minute.")).toBeTruthy();
    expect(screen.queryByText("Installing... checking status")).toBeNull();
    expect(screen.getByText("Switch to stable")).toBeTruthy();
  });

  it("clears the scheduled reload when unmounted after a successful install", async () => {
    let updateStarted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        if (updateStarted) {
          return Promise.resolve(jsonResponse({
            version: "v2026.05.28-151",
            release: {
              version: "v2026.05.28-151",
              channel: "stable",
              buildTime: "2026-05-28T19:53:18.421Z",
            },
          }));
        }
        return Promise.resolve(jsonResponse({
          version: "v2026.05.28-145",
          release: {
            version: "v2026.05.28-145",
            channel: "dev",
            buildTime: "2026-05-28T15:32:51.000Z",
          },
        }));
      }
      if (url.endsWith("/health")) {
        return Promise.resolve(jsonResponse({ status: "ok", cronJobs: 0, channels: {} }));
      }
      if (url.endsWith("/api/system/update?channel=dev")) {
        return Promise.resolve(jsonResponse({
          channel: "dev",
          latest: { version: "v2026.05.28-145" },
          updateAvailable: false,
        }));
      }
      if (url.endsWith("/api/system/releases?channel=dev")) {
        return Promise.resolve(jsonResponse({ channel: "dev", releases: [] }));
      }
      if (url.endsWith("/api/system/update?channel=stable")) {
        return Promise.resolve(jsonResponse({
          channel: "stable",
          latest: { version: "v2026.05.28-151" },
          updateAvailable: true,
        }));
      }
      if (url.endsWith("/api/system/releases?channel=stable")) {
        return Promise.resolve(jsonResponse({
          channel: "stable",
          releases: [{ version: "v2026.05.28-151", buildTime: "2026-05-28T19:53:18.421Z" }],
        }));
      }
      if (url.endsWith("/api/system/update") && init?.method === "POST") {
        updateStarted = true;
        return Promise.resolve(jsonResponse({ ok: true, status: "started", channel: "stable" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<SystemSection />);

    await waitFor(() => {
      expect(screen.getByText("Installed channel")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("Release channel"), {
      target: { value: "stable" },
    });

    await waitFor(() => {
      expect(screen.getByText("Switch to stable")).toBeTruthy();
    });

    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    fireEvent.click(screen.getByText("Switch to stable"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText("Installed. Reloading...")).toBeTruthy();
    const clearCallsBeforeUnmount = clearTimeoutSpy.mock.calls.length;

    act(() => {
      unmount();
    });

    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearCallsBeforeUnmount);
  });
});
