// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopSupportWidget from "@desktop/renderer/src/features/support/DesktopSupportWidget";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const posthogClient = vi.hoisted(() => ({
  conversations: {
    hide: vi.fn(),
  },
  identify: vi.fn(),
  init: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("posthog-js/dist/conversations", () => ({}));
vi.mock("posthog-js/dist/module.no-external", () => ({ default: posthogClient }));

describe("Desktop support widget", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_desktop_test");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://eu.posthog.com");
    useConnection.setState(useConnection.getInitialState(), true);
    useConnection.setState({
      status: "signed-in",
      handle: "neo",
      displayName: "Neo",
      platformHost: "https://app.matrix-os.com",
      authGeneration: 1,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("fails closed when PostHog cannot initialize", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    posthogClient.init.mockImplementationOnce(() => {
      throw new Error("provider details must stay private");
    });

    render(<DesktopSupportWidget />);

    await waitFor(() => expect(posthogClient.init).toHaveBeenCalledTimes(1));
    expect(posthogClient.identify).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      "[desktop-support] PostHog initialization failed:",
      "Error",
    );
  });

  it("loads PostHog Conversations through the first-party relay without broad Desktop capture", async () => {
    render(<DesktopSupportWidget />);

    await waitFor(() => expect(posthogClient.init).toHaveBeenCalledTimes(1));
    expect(posthogClient.init).toHaveBeenCalledWith(
      "phc_desktop_test",
      expect.objectContaining({
        api_host: "https://app.matrix-os.com/relay",
        ui_host: "https://eu.posthog.com",
        autocapture: false,
        capture_dead_clicks: false,
        capture_exceptions: false,
        capture_heatmaps: false,
        capture_pageleave: false,
        capture_pageview: false,
        capture_performance: false,
        disable_external_dependency_loading: true,
        disable_session_recording: true,
        disable_surveys: true,
        rageclick: false,
        persistence: "localStorage",
        persistence_name: "matrix_os_desktop_support",
      }),
    );
    expect(posthogClient.identify).toHaveBeenCalledWith("neo", {
      $name: "Neo",
      matrix_client: "desktop",
    });

    act(() => {
      useConnection.setState({
        status: "signed-out",
        handle: null,
        displayName: null,
        imageUrl: null,
        api: null,
      });
    });

    await waitFor(() => expect(posthogClient.conversations.hide).toHaveBeenCalledTimes(1));
    expect(posthogClient.reset).toHaveBeenCalledTimes(1);
  });
});
