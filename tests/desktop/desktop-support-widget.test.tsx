// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopModeControls from "@desktop/renderer/src/features/desktop-shell/DesktopModeControls";
import DesktopSupportWidget, { openDesktopSupport } from "@desktop/renderer/src/features/support/DesktopSupportWidget";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useBrowserNavigation } from "@desktop/renderer/src/stores/browser-navigation";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";

const posthogClient = vi.hoisted(() => ({
  conversations: {
    hide: vi.fn(),
    isAvailable: vi.fn(() => true),
    show: vi.fn(),
  },
  capture: vi.fn(),
  identify: vi.fn(),
  init: vi.fn(),
  register: vi.fn(),
  reset: vi.fn(),
  setPersonProperties: vi.fn(),
  set_config: vi.fn(),
  unregister: vi.fn(),
}));

const operatorClient = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ version: "1.4.0-canary.2" })),
}));

const runtimeApi = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    version: "v2026.08.31-installed",
    runningVersion: "v2026.09.02-running",
  })),
}));

vi.mock("posthog-js/dist/conversations", () => ({}));
vi.mock("posthog-js/dist/module.no-external", () => ({ default: posthogClient }));
vi.mock("@desktop/renderer/src/lib/operator", () => operatorClient);
vi.mock("@desktop/renderer/src/features/runtime/RuntimeComputerMenu", () => ({
  default: () => <button type="button">Main computer</button>,
}));
vi.mock("@desktop/renderer/src/features/onboarding/GettingStartedPopover", () => ({
  default: () => null,
}));
vi.mock("@desktop/renderer/src/features/mission-control/AccountMenu", () => ({
  default: () => <button type="button" aria-label="Open account menu">Avatar</button>,
}));

function renderPostHogLauncher(): HTMLDivElement {
  let container = document.getElementById("ph-conversations-widget-container") as HTMLDivElement | null;
  if (!container) {
    container = document.createElement("div");
    container.id = "ph-conversations-widget-container";
    document.body.appendChild(container);
  }
  container.replaceChildren();
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open chat");
  launcher.addEventListener("click", () => {
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", renderPostHogLauncher);
    container?.replaceChildren(close);
  });
  container.appendChild(launcher);
  return container;
}

function renderPersistedOpenPostHogPanel(): HTMLDivElement {
  let container = document.getElementById("ph-conversations-widget-container") as HTMLDivElement | null;
  if (!container) {
    container = document.createElement("div");
    container.id = "ph-conversations-widget-container";
    document.body.appendChild(container);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", renderPostHogLauncher);
  container.replaceChildren(close);
  return container;
}

describe("Desktop support widget", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_desktop_test");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://eu.posthog.com");
    useConnection.setState(useConnection.getInitialState(), true);
    useConnection.setState({
      status: "signed-in",
      handle: "neo",
      userId: "user_2abcDEF",
      displayName: "Neo",
      email: "neo@example.com",
      platformHost: "https://app.matrix-os.com",
      authGeneration: 1,
      api: runtimeApi as never,
    });
    useBrowserNavigation.setState(useBrowserNavigation.getInitialState(), true);
    useTabs.setState(useTabs.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
  });

  afterEach(async () => {
    await act(async () => {
      useConnection.setState({
        status: "signed-out",
        handle: null,
        userId: null,
        displayName: null,
        imageUrl: null,
        email: null,
        api: null,
      });
      await Promise.resolve();
    });
    cleanup();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    document.getElementById("ph-conversations-widget-container")?.remove();
    document.getElementById("unrelated-close")?.remove();
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

  it("keeps Support visible without redirecting an unconfigured chat button to docs", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");

    render(<DesktopModeControls />);
    expect(screen.getByRole("button", { name: "Support" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Support" }));

    await act(async () => Promise.resolve());
    expect(useTabs.getState().tabs).toEqual([]);
    expect(useBrowserNavigation.getState().pending).toBeNull();
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
    expect(posthogClient.identify).toHaveBeenCalledWith("user_2abcDEF", {
      $name: "Neo",
      email: "neo@example.com",
      matrix_client: "desktop",
      matrix_bundle_version: "v2026.09.02-running",
      matrix_desktop_version: "1.4.0-canary.2",
    });
    expect(posthogClient.register).toHaveBeenCalledWith({
      matrix_client: "desktop",
      matrix_bundle_version: "v2026.09.02-running",
      matrix_desktop_version: "1.4.0-canary.2",
    });
    expect(posthogClient.setPersonProperties).toHaveBeenCalledWith({
      matrix_client: "desktop",
      matrix_bundle_version: "v2026.09.02-running",
      matrix_desktop_version: "1.4.0-canary.2",
    });
    expect(posthogClient.conversations.hide).toHaveBeenCalledTimes(1);

    act(() => {
      useConnection.setState({
        status: "signed-out",
        handle: null,
        userId: null,
        displayName: null,
        imageUrl: null,
        email: null,
        api: null,
      });
    });

    await waitFor(() => expect(posthogClient.conversations.hide).toHaveBeenCalledTimes(2));
    expect(posthogClient.reset).toHaveBeenCalledTimes(1);
  });

  it("clears a stale email during initial Clerk identification", async () => {
    useConnection.setState({ email: null });

    render(<DesktopSupportWidget />);

    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalledWith("user_2abcDEF", {
      $name: "Neo",
      email: null,
      matrix_client: "desktop",
      matrix_bundle_version: "v2026.09.02-running",
      matrix_desktop_version: "1.4.0-canary.2",
    }));
  });

  it("opens support from beside the avatar without leaving the default launcher", async () => {
    posthogClient.conversations.hide.mockImplementation(() => {
      document.getElementById("ph-conversations-widget-container")?.remove();
    });
    posthogClient.conversations.show.mockImplementation(() => {
      renderPostHogLauncher();
    });

    render(
      <>
        <DesktopSupportWidget />
        <DesktopModeControls />
      </>,
    );

    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalled());
    // PostHog restores persisted widget state asynchronously after identity
    // setup. A previous open session must not cover the Desktop after login.
    renderPersistedOpenPostHogPanel();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close" })).toBeNull());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull());

    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual([
        "Search",
        "Support",
        "Join Discord",
        "Main computer",
        "Open account menu",
      ]);

    const unrelatedClose = document.createElement("button");
    unrelatedClose.id = "unrelated-close";
    unrelatedClose.setAttribute("aria-label", "Close");
    document.body.appendChild(unrelatedClose);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(useUi.getState().paletteOpen).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Support" }));

    await waitFor(() => expect(posthogClient.conversations.show).toHaveBeenCalledTimes(1));
    expect(useUi.getState().rendererOverlayCount).toBe(1);
    await waitFor(() => {
      expect(
        document.querySelector('#ph-conversations-widget-container button[aria-label="Close"]'),
      ).not.toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();

    // PostHog can re-render its panel while it is open. Replacing the close
    // control exercises the user-visible contract without relying on a
    // listener remaining attached to one provider-owned DOM node.
    const close = document.querySelector<HTMLButtonElement>(
      '#ph-conversations-widget-container button[aria-label="Close"]',
    )!;
    const replacementClose = close.cloneNode(true) as HTMLButtonElement;
    replacementClose.addEventListener("click", renderPostHogLauncher);
    close.replaceWith(replacementClose);
    fireEvent.click(replacementClose);

    await waitFor(() => expect(document.getElementById("ph-conversations-widget-container")).toBeNull());
    await waitFor(() => expect(useUi.getState().rendererOverlayCount).toBe(0));
    expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Support" }));

    await waitFor(() => expect(posthogClient.conversations.show).toHaveBeenCalledTimes(2));
    expect(useUi.getState().rendererOverlayCount).toBe(1);
    await waitFor(() => {
      expect(
        document.querySelector('#ph-conversations-widget-container button[aria-label="Close"]'),
      ).not.toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
  });

  it("rebinds support to the selected runtime relay", async () => {
    render(<DesktopSupportWidget />);

    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalledWith("user_2abcDEF", {
      $name: "Neo",
      email: "neo@example.com",
      matrix_client: "desktop",
      matrix_bundle_version: "v2026.09.02-running",
      matrix_desktop_version: "1.4.0-canary.2",
    }));
    runtimeApi.get.mockResolvedValueOnce({
      version: "v2026.09.02-installed",
      runningVersion: "v2026.09.03-preview",
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
    expect(posthogClient.reset).toHaveBeenCalledTimes(1);
    expect(posthogClient.identify).toHaveBeenLastCalledWith("user_2abcDEF", {
      $name: "Neo",
      email: "neo@example.com",
      matrix_client: "desktop",
      matrix_bundle_version: "v2026.09.03-preview",
      matrix_desktop_version: "1.4.0-canary.2",
    });
    expect(posthogClient.register).toHaveBeenLastCalledWith({
      matrix_client: "desktop",
      matrix_bundle_version: "v2026.09.03-preview",
      matrix_desktop_version: "1.4.0-canary.2",
    });
  });

  it("updates person metadata without resetting the same Clerk identity", async () => {
    render(<DesktopSupportWidget />);
    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalledTimes(1));
    const resetCalls = posthogClient.reset.mock.calls.length;

    act(() => {
      useConnection.setState({
        displayName: "The One",
        email: "the-one@example.com",
      });
    });

    await waitFor(() => expect(posthogClient.setPersonProperties).toHaveBeenLastCalledWith({
      $name: "The One",
      email: "the-one@example.com",
    }));
    expect(posthogClient.identify).toHaveBeenCalledTimes(1);
    expect(posthogClient.reset).toHaveBeenCalledTimes(resetCalls);
  });

  it("clears a stale email without resetting the same Clerk identity", async () => {
    render(<DesktopSupportWidget />);
    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalledTimes(1));
    const resetCalls = posthogClient.reset.mock.calls.length;

    act(() => {
      useConnection.setState({ email: null });
    });

    await waitFor(() => expect(posthogClient.setPersonProperties).toHaveBeenLastCalledWith({
      $name: "Neo",
      email: null,
    }));
    expect(posthogClient.identify).toHaveBeenCalledTimes(1);
    expect(posthogClient.reset).toHaveBeenCalledTimes(resetCalls);
  });

  it("keeps support available when runtime and native version metadata are unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runtimeApi.get.mockRejectedValueOnce(new Error("private runtime failure"));
    operatorClient.invoke.mockRejectedValueOnce(new Error("private IPC failure"));

    render(<DesktopSupportWidget />);

    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalledWith("user_2abcDEF", {
      $name: "Neo",
      email: "neo@example.com",
      matrix_client: "desktop",
    }));
    expect(posthogClient.register).toHaveBeenCalledWith({ matrix_client: "desktop" });
    expect(posthogClient.unregister).toHaveBeenCalledWith("matrix_bundle_version");
    expect(posthogClient.unregister).toHaveBeenCalledWith("matrix_desktop_version");
    expect(warning).toHaveBeenCalledWith(
      "[desktop-support] Runtime metadata unavailable:",
      "Error",
    );
    expect(warning).toHaveBeenCalledWith(
      "[desktop-support] Native app version unavailable:",
      "Error",
    );
  });

  it("captures bounded Desktop lifecycle events after identifying the account", async () => {
    render(<DesktopSupportWidget />);
    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalled());

    window.dispatchEvent(new CustomEvent("matrix:desktop-analytics", {
      detail: { name: "desktop_app_opened", appKind: "browser" },
    }));

    expect(posthogClient.capture).toHaveBeenCalledWith("desktop_app_opened", {
      app_kind: "browser",
      matrix_client: "desktop",
    });
  });

  it("does not finish an old support open after sign-out", async () => {
    posthogClient.conversations.hide.mockImplementation(() => {
      document.getElementById("ph-conversations-widget-container")?.remove();
    });
    posthogClient.conversations.show.mockImplementation(() => undefined);

    render(
      <>
        <DesktopSupportWidget />
        <DesktopModeControls />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Support" }));
    await waitFor(() => expect(posthogClient.conversations.show).toHaveBeenCalledTimes(1));
    const resetCallsBeforeSignOut = posthogClient.reset.mock.calls.length;

    act(() => {
      useConnection.setState({
        status: "signed-out",
        handle: null,
        userId: null,
        displayName: null,
        imageUrl: null,
        email: null,
        api: null,
      });
    });
    await waitFor(() => {
      expect(posthogClient.reset.mock.calls.length).toBeGreaterThan(resetCallsBeforeSignOut);
    });

    renderPostHogLauncher();

    await waitFor(() => expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("honors a support click while the widget is still initializing", async () => {
    posthogClient.conversations.hide.mockImplementation(() => {
      document.getElementById("ph-conversations-widget-container")?.remove();
    });
    posthogClient.conversations.show.mockImplementation(renderPostHogLauncher);

    const opening = openDesktopSupport();
    render(<DesktopSupportWidget />);

    await expect(opening).resolves.toBe(true);
    expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();
  });
});
