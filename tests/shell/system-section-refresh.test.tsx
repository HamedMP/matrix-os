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
});
