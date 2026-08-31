// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopPostHogAnalytics from "@desktop/renderer/src/features/analytics/DesktopPostHogAnalytics";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const posthogClient = vi.hoisted(() => ({
  capture: vi.fn(),
  identify: vi.fn(),
  init: vi.fn(),
  reset: vi.fn(),
  set_config: vi.fn(),
}));

vi.mock("posthog-js/dist/module.no-external", () => ({ default: posthogClient }));

describe("Desktop PostHog analytics", () => {
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

    render(<DesktopPostHogAnalytics />);

    await waitFor(() => expect(posthogClient.init).toHaveBeenCalledTimes(1));
    expect(posthogClient.identify).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      "[desktop-analytics] PostHog initialization failed:",
      "Error",
    );
  });

  it("keeps bounded Desktop analytics without loading a support widget", async () => {
    render(<DesktopPostHogAnalytics />);

    await waitFor(() => expect(posthogClient.init).toHaveBeenCalledTimes(1));
    expect(posthogClient.init).toHaveBeenCalledWith(
      "phc_desktop_test",
      expect.objectContaining({
        api_host: "https://app.matrix-os.com/relay",
        ui_host: "https://eu.posthog.com",
        autocapture: false,
        capture_exceptions: false,
        disable_conversations: true,
        disable_external_dependency_loading: true,
        disable_session_recording: true,
        persistence: "localStorage",
      }),
    );
    expect(posthogClient.identify).toHaveBeenCalledWith("neo", {
      $name: "Neo",
      matrix_client: "desktop",
    });

    window.dispatchEvent(new CustomEvent("matrix:desktop-analytics", {
      detail: { name: "desktop_app_opened", appKind: "browser" },
    }));
    expect(posthogClient.capture).toHaveBeenCalledWith("desktop_app_opened", {
      app_kind: "browser",
      matrix_client: "desktop",
    });

    act(() => {
      useConnection.setState({
        platformHost: "https://preview.matrix-os.com",
        authGeneration: 2,
      });
    });
    await waitFor(() => {
      expect(posthogClient.set_config).toHaveBeenCalledWith({
        api_host: "https://preview.matrix-os.com/relay",
      });
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
    await waitFor(() => expect(posthogClient.reset).toHaveBeenCalled());
  });
});
