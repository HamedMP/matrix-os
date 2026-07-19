// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChannelsSection from "../../desktop/src/renderer/src/features/settings/sections/ChannelsSection";
import CronSection from "../../desktop/src/renderer/src/features/settings/sections/CronSection";
import SystemSection from "../../desktop/src/renderer/src/features/settings/sections/SystemSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

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
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "channels",
      Component: ChannelsSection,
      unavailable: "Channels unavailable.",
      response: [{ name: "telegram", connected: true }],
      visible: "telegram",
    },
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
    render(<Component />);

    await waitFor(() => {
      expect(screen.queryByText(unavailable)).not.toBeNull();
    });

    await act(async () => {
      useConnection.setState({ api: makeApi(response) });
    });

    await waitFor(() => {
      expect(screen.queryByText(unavailable)).toBeNull();
      expect(screen.queryByText(visible)).not.toBeNull();
    });
  });

  it.each([
    {
      name: "channels",
      Component: ChannelsSection,
      loading: "Loading channels...",
      empty: "No channels configured yet.",
    },
    {
      name: "cron",
      Component: CronSection,
      loading: "Loading schedules...",
      empty: "No scheduled jobs.",
    },
  ])("shows loading instead of empty state while $name load is pending", ({ Component, loading, empty }) => {
    useConnection.setState({ api: makePendingApi() });

    render(<Component />);

    expect(screen.queryByText(loading)).not.toBeNull();
    expect(screen.queryByText(empty)).toBeNull();
  });
});
