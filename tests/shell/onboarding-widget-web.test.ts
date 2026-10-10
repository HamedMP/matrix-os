// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingWidgetHost } from "@/components/onboarding-widget/OnboardingWidgetHost";
import { useWindowManager } from "@/hooks/useWindowManager";
import { CanonicalShellChatRequestError } from "@/lib/canonical-chat-client";
import { isShellSupportOpen, subscribeShellSupportPanel } from "@/lib/posthog-client";
import {
  createShellOnboardingRepoSource,
  isShellComputerStarting,
  isShellNotFound,
  shellOnboardingIdentity,
} from "@/components/onboarding-widget/shell-onboarding-ports";
import { useShellOnboardingIntegrations } from "@/components/onboarding-widget/use-shell-onboarding-integrations";

const GATEWAY = "https://app.example.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.getElementById("ph-conversations-widget-container")?.remove();
  localStorage.clear();
});

describe("web onboarding widget host", () => {
  function stubGateway() {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.endsWith("/api/identity")) return json({ handle: "sahar", displayName: "Sahar K" });
      if (input.endsWith("/api/system/info")) return json({ runtime: { runtimeSlot: "primary" } });
      if (input.endsWith("/api/integrations/available")) return json({ services: [] });
      if (input.endsWith("/api/integrations")) return json([]);
      return json({ error: "unavailable" }, 503);
    }));
  }

  function renderHost() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(createElement(
      QueryClientProvider,
      { client },
      createElement(OnboardingWidgetHost, { onOpenChat: vi.fn(), onOpenSettings: vi.fn() }),
    ));
  }

  it("greets the owner on first visit and docks support above it", async () => {
    stubGateway();
    const { unmount } = renderHost();
    expect(await screen.findByText(/Sahar/)).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.mxoOnboarding).toBe("card-right"));
    unmount();
    expect(document.documentElement.dataset.mxoOnboarding).toBeUndefined();
  });

  it("hides app connecting when this computer has no integration service", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.endsWith("/api/identity")) return json({ handle: "sahar", displayName: "Sahar K" });
      if (input.endsWith("/api/system/info")) return json({ runtime: { runtimeSlot: "primary" } });
      if (input.includes("/api/integrations")) return json({ error: "Not Found" }, 404);
      if (input.includes("/api/github/repos")) {
        return json({ repos: [{ nameWithOwner: "sahar/portfolio", url: "https://github.com/sahar/portfolio", updatedAt: null }] });
      }
      return json({ error: "unavailable" }, 503);
    }));
    renderHost();
    await screen.findByText(/Sahar/);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Connect apps first" })).toBeNull());
    act(() => screen.getByRole("button", { name: /Work on my code/ }).click());
    expect(screen.getByText("App connections aren't available on this computer")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Skip" }).click());
    expect(await screen.findByRole("button", { name: /portfolio/ })).toBeTruthy();
  });

  it("steps aside while Chat is maximized and comes back after", async () => {
    stubGateway();
    const { container } = renderHost();
    await screen.findByText(/Sahar/);
    const chatWindow = { id: "w1", title: "Chat", path: "__chat__", x: 0, y: 0, width: 800, height: 600, minimized: false, zIndex: 1 };
    act(() => useWindowManager.setState({ windows: [chatWindow], fullscreenWindowId: "w1" }));
    expect(container.querySelector(".mxo-root")).toBeNull();
    expect(document.documentElement.dataset.mxoOnboarding).toBeUndefined();
    act(() => useWindowManager.setState({ fullscreenWindowId: null }));
    expect(container.querySelector(".mxo-root")).not.toBeNull();
  });
});

describe("web support panel state", () => {
  it("reports the PostHog panel opening and closing, even when its container mounts late", async () => {
    const onChange = vi.fn();
    const dispose = subscribeShellSupportPanel(onChange);
    expect(isShellSupportOpen()).toBe(false);

    const container = document.createElement("div");
    container.id = "ph-conversations-widget-container";
    document.body.appendChild(container);
    const close = document.createElement("button");
    close.setAttribute("aria-label", "Close");
    container.appendChild(close);
    await waitFor(() => expect(isShellSupportOpen()).toBe(true));
    const calls = onChange.mock.calls.length;
    expect(calls).toBeGreaterThan(0);

    close.remove();
    await waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThan(calls));
    expect(isShellSupportOpen()).toBe(false);
    dispose();
  });
});

describe("web onboarding chat port", () => {
  it("treats only network failures and gateway outages as the computer still starting", () => {
    expect(isShellComputerStarting(new TypeError("Failed to fetch"))).toBe(true);
    expect(isShellComputerStarting(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isShellComputerStarting(new CanonicalShellChatRequestError(502))).toBe(true);
    expect(isShellComputerStarting(new CanonicalShellChatRequestError(503))).toBe(true);
    expect(isShellComputerStarting(new CanonicalShellChatRequestError(504))).toBe(true);
    expect(isShellComputerStarting(new CanonicalShellChatRequestError(500))).toBe(false);
    expect(isShellComputerStarting(new CanonicalShellChatRequestError(409))).toBe(false);
    expect(isShellComputerStarting(new Error("offline"))).toBe(false);
  });

  it("only a 404 means the remembered chat is gone", () => {
    expect(isShellNotFound(new CanonicalShellChatRequestError(404))).toBe(true);
    expect(isShellNotFound(new CanonicalShellChatRequestError(403))).toBe(false);
    expect(isShellNotFound(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("web onboarding repo source", () => {
  it("reads repos through the gateway with a bounded timeout", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ data: [] })).mockResolvedValueOnce(json({ repos: [] }));
    const source = createShellOnboardingRepoSource(GATEWAY, fetchFn);
    const signal = new AbortController().signal;
    const request = { service: "github", action: "list_repos", label: "sahar", connectionId: "conn_1", params: { sort: "updated", per_page: 20 } } as const;

    await expect(source.readGithubApp(request, signal)).resolves.toEqual({ data: [] });
    await expect(source.listComputerRepos(20, signal)).resolves.toEqual({ repos: [] });

    const [readUrl, readInit] = fetchFn.mock.calls[0]!;
    expect(readUrl).toBe(`${GATEWAY}/api/integrations/read-call`);
    expect(readInit).toMatchObject({ method: "POST", body: JSON.stringify(request) });
    expect(readInit.signal).toBeInstanceOf(AbortSignal);
    expect(fetchFn.mock.calls[1]![0]).toBe(`${GATEWAY}/api/github/repos?limit=20`);
  });

  it("rejects failed reads instead of parsing error bodies", async () => {
    const source = createShellOnboardingRepoSource(GATEWAY, vi.fn().mockResolvedValue(json({ error: "nope" }, 502)));
    await expect(source.listComputerRepos(20, new AbortController().signal)).rejects.toThrow();
  });
});

describe("web onboarding identity", () => {
  it("scopes prefs to the owner handle and runtime slot", () => {
    expect(shellOnboardingIdentity({ handle: "sahar", displayName: "Sahar K" }, { runtime: { runtimeSlot: "staging-2" } }))
      .toEqual({ handle: "sahar", runtimeSlot: "staging-2", displayName: "Sahar K" });
  });

  it("falls back to a stable owner and the primary slot when identity is missing or malformed", () => {
    expect(shellOnboardingIdentity(null, null)).toEqual({ handle: "owner", runtimeSlot: "primary", displayName: null });
    expect(shellOnboardingIdentity({ handle: "", displayName: 7 }, { runtime: { runtimeSlot: "../x" } }))
      .toEqual({ handle: "owner", runtimeSlot: "primary", displayName: null });
  });
});

describe("web onboarding app connect", () => {
  const services = { services: [{ id: "github", name: "GitHub", category: "dev" }] };

  function popupStub() {
    const popup = { opener: {} as unknown, location: { href: "about:blank" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    return popup;
  }

  it("loads apps, opens consent in a popup and confirms once the new connection lands", async () => {
    const popup = popupStub();
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/integrations/available")) return json(services);
      if (url.endsWith("/api/integrations")) return json([]);
      if (url.endsWith("/api/integrations/connect")) return json({ url: "https://consent.example.test/github" });
      if (url.endsWith("/api/integrations/sync")) {
        return json({ services: [{ id: "conn_1", service: "github", account_label: "sahar", status: "active" }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0] }));
    await waitFor(() => expect(result.current.available).toHaveLength(1));

    act(() => result.current.connectApp("github"));
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank", "width=600,height=700");
    expect(result.current.connectingService).toBe("github");
    expect(dispatch).toHaveBeenCalledWith({ type: "connect.started" });

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.succeeded" }));
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe("https://consent.example.test/github");
    expect(result.current.connectingService).toBeNull();
    expect(result.current.connections.map((connection) => connection.id)).toEqual(["conn_1"]);
  });

  it("fails without a request when the browser blocks the popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFn = vi.fn(async () => json([]));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0] }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));

    act(() => result.current.connectApp("github"));
    expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.current.connectingService).toBeNull();
  });

  it("closes the popup and fails when the consent URL is not HTTPS", async () => {
    const popup = popupStub();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFn = vi.fn(async (url: string) => (url.endsWith("/connect") ? json({ url: "javascript:alert(1)" }) : json([])));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0] }));

    act(() => result.current.connectApp("github"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed" }));
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.href).toBe("about:blank");
  });

  it("knows up front when the computer has no app connections and never opens a consent window", async () => {
    vi.spyOn(window, "open");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFn = vi.fn(async () => json({ error: "Not Found" }, 404));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0] }));
    await waitFor(() => expect(result.current.appsUnavailable).toBe(true));

    act(() => result.current.connectApp("github"));
    expect(dispatch).toHaveBeenCalledWith({ type: "connect.unavailable" });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "connect.started" });
    expect(window.open).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("switches to unavailable when the connect request finds no integration service", async () => {
    const popup = popupStub();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFn = vi.fn(async (url: string) => (url.endsWith("/connect") ? json({ error: "Not Found" }, 404) : json({ error: "busy" }, 503)));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0] }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(result.current.appsUnavailable).toBe(false);

    act(() => result.current.connectApp("github"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.unavailable" }));
    expect(dispatch).not.toHaveBeenCalledWith({ type: "connect.failed" });
    expect(popup.close).toHaveBeenCalled();
    expect(result.current.appsUnavailable).toBe(true);
    expect(result.current.connectingService).toBeNull();
  });

  it("keeps a server error retryable instead of calling it unavailable", async () => {
    const popup = popupStub();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFn = vi.fn(async (url: string) => (url.endsWith("/connect") ? json({ error: "busy" }, 502) : json([])));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0] }));

    act(() => result.current.connectApp("github"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed" }));
    expect(popup.close).toHaveBeenCalled();
    expect(result.current.appsUnavailable).toBe(false);
  });

  it("gives up when the connection never lands", async () => {
    popupStub();
    const fetchFn = vi.fn(async (url: string) => (url.endsWith("/connect") ? json({ url: "https://consent.example.test/github" }) : json([])));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0, 0] }));

    act(() => result.current.connectApp("github"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed" }));
    expect(result.current.connectingService).toBeNull();
  });
});
