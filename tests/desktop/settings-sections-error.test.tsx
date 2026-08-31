// @vitest-environment jsdom

import React from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CronSection from "../../desktop/src/renderer/src/features/settings/sections/CronSection";
import SystemSection from "../../desktop/src/renderer/src/features/settings/sections/SystemSection";
import { createDesktopQueryClient } from "../../desktop/src/renderer/src/lib/query-client";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

let queryClient: QueryClient;

function renderSection(Component: React.ComponentType) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Component />
    </QueryClientProvider>,
  );
}

function makeApi(response: unknown, reject = false) {
  return {
    get: vi.fn(reject ? async () => {
      throw new Error("offline");
    } : async () => response),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  } as never;
}

function makePendingApi() {
  return {
    get: vi.fn(() => new Promise(() => undefined)),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  } as never;
}

describe("settings data sections", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    queryClient = createDesktopQueryClient();
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: makeApi(null, true),
    });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "cron",
      Component: CronSection,
      unavailable: "Schedules unavailable.",
      response: [{ id: "nightly", name: "Nightly", schedule: "0 0 * * *" }],
      visible: "Nightly",
    },
    {
      name: "system",
      Component: SystemSection,
      unavailable: "System info unavailable.",
      response: { version: "1.0.0" },
      visible: "1.0.0",
    },
  ])("clears stale $name errors after a successful retry", async ({ Component, unavailable, response, visible }) => {
    const failingApi = useConnection.getState().api;
    renderSection(Component);

    await waitFor(
      () => {
        expect(screen.queryByText(unavailable)).not.toBeNull();
      },
      { timeout: 2_500 },
    );
    if (name === "cron") {
      expect(failingApi.get).toHaveBeenCalledTimes(2);
    }

    await act(async () => {
      useConnection.setState({ api: makeApi(response) });
    });
    await act(async () => {
      await queryClient.refetchQueries();
    });

    await waitFor(() => {
      expect(screen.queryByText(unavailable)).toBeNull();
      expect(screen.getAllByText(visible).length).toBeGreaterThan(0);
    });
  });

  it.each([
    {
      name: "cron",
      Component: CronSection,
      loading: "Loading schedules...",
      empty: "No scheduled jobs.",
    },
  ])("shows loading instead of empty state while $name load is pending", ({ Component, loading, empty }) => {
    useConnection.setState({ api: makePendingApi() });

    renderSection(Component);

    expect(screen.queryByText(loading)).not.toBeNull();
    expect(screen.queryByText(empty)).toBeNull();
  });

  it("shows installed and running bundle versions when an update is only partially applied", async () => {
    useConnection.setState({
      api: makeApi({
        version: "v2026.08.19-1002",
        runningVersion: "v2026.08.18-997",
      }),
    });

    renderSection(SystemSection);

    expect(await screen.findByText("Installed version")).not.toBeNull();
    expect(screen.getByText("Running version")).not.toBeNull();
    expect(screen.getByText(
      "The running services do not match the installed update. Restart Matrix services to finish applying it.",
    )).not.toBeNull();
  });
});
