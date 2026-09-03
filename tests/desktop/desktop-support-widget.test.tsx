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

const operatorEventListeners = vi.hoisted(() => ({
  analyticsCapture: null as null | ((payload: unknown) => void),
  flushRequested: null as null | ((payload: unknown) => void),
}));

const posthogClient = vi.hoisted(() => ({
  conversations: {
    hide: vi.fn(),
    isAvailable: vi.fn(() => true),
    show: vi.fn(),
  },
  capture: vi.fn(),
  clearIdentity: vi.fn(),
  identify: vi.fn(),
  init: vi.fn(),
  register: vi.fn(),
  reset: vi.fn(),
  shutdown: vi.fn(async () => undefined),
  setIdentity: vi.fn(),
  setPersonProperties: vi.fn(),
  set_config: vi.fn(),
  unregister: vi.fn(),
}));

const operatorClient = vi.hoisted(() => ({
  onEvent: vi.fn((channel: string, callback: (payload: unknown) => void) => {
    if (channel === "analytics:capture") operatorEventListeners.analyticsCapture = callback;
    if (channel === "analytics:flush-requested") operatorEventListeners.flushRequested = callback;
    return () => undefined;
  }),
  invoke: vi.fn(async (channel: string) => channel === "support:get-identity"
    ? {
        status: "verified",
        distinctId: "user_2abcDEF",
        identityHash: "ab".repeat(32),
      }
    : { version: "1.4.0-canary.2" }),
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
    operatorEventListeners.analyticsCapture = null;
    operatorEventListeners.flushRequested = null;
    operatorClient.invoke.mockImplementation(async (channel: string) => channel === "support:get-identity"
      ? {
          status: "verified",
          distinctId: "user_2abcDEF",
          identityHash: "ab".repeat(32),
        }
      : { version: "1.4.0-canary.2" });
    posthogClient.conversations.isAvailable.mockReturnValue(true);
    posthogClient.capture.mockImplementation(() => undefined);
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
    expect(posthogClient.setIdentity).toHaveBeenCalledWith("user_2abcDEF", "ab".repeat(32));
    expect(posthogClient.identify.mock.invocationCallOrder[0]).toBeLessThan(
      posthogClient.setIdentity.mock.invocationCallOrder[0]!,
    );
    expect(posthogClient.capture).toHaveBeenCalledWith("desktop_auth_completed", {
      matrix_client: "desktop",
    });
    expect(posthogClient.capture).toHaveBeenCalledWith("desktop_application_opened", {
      matrix_client: "desktop",
    });
    const authCapture = posthogClient.capture.mock.calls.findIndex(
      ([name]) => name === "desktop_auth_completed",
    );
    expect(posthogClient.identify.mock.invocationCallOrder[0]).toBeLessThan(
      posthogClient.capture.mock.invocationCallOrder[authCapture]!,
    );
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
    expect(posthogClient.capture).toHaveBeenCalledWith("desktop_sign_out", {
      matrix_client: "desktop",
    });
    expect(posthogClient.clearIdentity).toHaveBeenCalledTimes(1);
    expect(posthogClient.clearIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      posthogClient.reset.mock.invocationCallOrder[0]!,
    );
    expect(posthogClient.reset).toHaveBeenCalledTimes(1);
  });

  it("keeps Support available when verified identity is transiently unavailable", async () => {
    operatorClient.invoke.mockImplementation(async (channel: string) => channel === "support:get-identity"
      ? { status: "unavailable" }
      : { version: "1.4.0-canary.2" });

    render(<DesktopSupportWidget />);

    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalled());
    expect(posthogClient.setIdentity).not.toHaveBeenCalled();
    expect(posthogClient.capture).toHaveBeenCalledWith(
      "desktop_support_identity_unavailable",
      { matrix_client: "desktop" },
    );
  });

  it("keeps Support available when analytics capture itself fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    posthogClient.conversations.hide.mockImplementation(() => {
      document.getElementById("ph-conversations-widget-container")?.remove();
    });
    posthogClient.conversations.show.mockImplementation(renderPostHogLauncher);
    render(<DesktopSupportWidget />);
    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalled());
    posthogClient.capture.mockImplementationOnce(() => {
      throw new Error("provider capture failure");
    });

    await expect(openDesktopSupport()).resolves.toBe(true);
    expect(warning).toHaveBeenCalledWith(
      "[desktop-support] Analytics capture unavailable:",
      "Error",
    );
  });

  it("does not apply an old identity response after the Clerk account changes", async () => {
    let resolveIdentity: ((value: unknown) => void) | undefined;
    operatorClient.invoke.mockImplementation((channel: string) => channel === "support:get-identity"
      ? new Promise((resolve) => { resolveIdentity = resolve; })
      : Promise.resolve({ version: "1.4.0-canary.2" }));

    render(<DesktopSupportWidget />);
    await waitFor(() => expect(resolveIdentity).toBeDefined());

    act(() => {
      useConnection.setState({
        handle: "trinity",
        userId: "user_trinity",
        authGeneration: 2,
      });
    });
    act(() => resolveIdentity?.({
      status: "verified",
      distinctId: "user_2abcDEF",
      identityHash: "ab".repeat(32),
    }));

    await act(async () => Promise.resolve());
    expect(posthogClient.setIdentity).not.toHaveBeenCalledWith("user_2abcDEF", expect.any(String));
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
    expect(posthogClient.capture).toHaveBeenCalledWith("desktop_support_opened", {
      matrix_client: "desktop",
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
    expect(posthogClient.capture).toHaveBeenCalledWith("desktop_support_closed", {
      matrix_client: "desktop",
    });
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
    operatorClient.invoke.mockImplementation(async (channel: string) => {
      if (channel === "app:get-version") throw new Error("private IPC failure");
      return {
        status: "verified",
        distinctId: "user_2abcDEF",
        identityHash: "ab".repeat(32),
      };
    });

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

  it("captures main-process Support send events under the active Clerk identity", async () => {
    render(<DesktopSupportWidget />);
    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalled());
    expect(operatorEventListeners.analyticsCapture).not.toBeNull();

    act(() => operatorEventListeners.analyticsCapture?.({
      name: "desktop_support_send_failed",
      failureKind: "server",
    }));

    expect(posthogClient.capture).toHaveBeenCalledWith("desktop_support_send_failed", {
      failure_kind: "server",
      matrix_client: "desktop",
    });
  });

  it("maps Chat send telemetry to coarse PostHog properties only", async () => {
    render(<DesktopSupportWidget />);
    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalled());

    window.dispatchEvent(new CustomEvent("matrix:desktop-analytics", {
      detail: {
        name: "desktop_chat_message_send_failed",
        chatScope: "project",
        hasAttachments: true,
        failureKind: "network",
      },
    }));

    expect(posthogClient.capture).toHaveBeenCalledWith(
      "desktop_chat_message_send_failed",
      {
        chat_scope: "project",
        failure_kind: "network",
        has_attachments: true,
        matrix_client: "desktop",
      },
    );
  });

  it("maps Chat routing and response length without content properties", async () => {
    render(<DesktopSupportWidget />);
    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalled());

    window.dispatchEvent(new CustomEvent("matrix:desktop-analytics", {
      detail: {
        name: "desktop_chat_response_completed",
        chatScope: "global",
        harness: "hermes",
        modelProvider: "anthropic",
        model: "anthropic:claude-opus-5",
        responseCharacterCount: 420,
      },
    }));

    expect(posthogClient.capture).toHaveBeenCalledWith(
      "desktop_chat_response_completed",
      {
        chat_scope: "global",
        harness: "hermes",
        matrix_client: "desktop",
        model: "anthropic:claude-opus-5",
        model_provider: "anthropic",
        response_character_count: 420,
      },
    );
    expect(JSON.stringify(posthogClient.capture.mock.calls)).not.toContain("private response");
  });

  it("waits for the quit event HTTP response before acknowledging the main process", async () => {
    let finishRequest: ((response: Response) => void) | undefined;
    const quitPayload = {
      uuid: "019cc3de-7b86-7000-8000-000000000001",
      event: "desktop_application_quit_requested",
      properties: {
        token: "phc_desktop_test",
        distinct_id: "user_2abcDEF",
        matrix_client: "desktop",
      },
      timestamp: "2026-09-03T06:27:26.000Z",
    };
    posthogClient.capture.mockImplementation((name: string) =>
      name === "desktop_application_quit_requested" ? quitPayload : undefined);
    const request = vi.fn(() => new Promise<Response>((resolve) => { finishRequest = resolve; }));
    vi.stubGlobal("fetch", request);
    render(<DesktopSupportWidget />);
    await waitFor(() => expect(posthogClient.identify).toHaveBeenCalled());
    expect(operatorEventListeners.flushRequested).not.toBeNull();

    act(() => {
      operatorEventListeners.flushRequested?.({});
    });

    expect(posthogClient.capture).toHaveBeenCalledWith(
      "desktop_application_quit_requested",
      { matrix_client: "desktop" },
    );
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://app.matrix-os.com/relay/i/v0/e/");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quitPayload),
    });
    expect(operatorClient.invoke).not.toHaveBeenCalledWith("analytics:flush-complete", {});
    expect(posthogClient.shutdown).not.toHaveBeenCalled();

    finishRequest?.(new Response(null, { status: 200 }));
    await waitFor(() => {
      expect(posthogClient.shutdown).toHaveBeenCalledOnce();
      expect(operatorClient.invoke).toHaveBeenCalledWith("analytics:flush-complete", {});
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
    const captureCountAfterSignOut = posthogClient.capture.mock.calls.length;
    window.dispatchEvent(new CustomEvent("matrix:desktop-analytics", {
      detail: { name: "desktop_support_opened" },
    }));
    expect(posthogClient.capture).toHaveBeenCalledTimes(captureCountAfterSignOut);

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
