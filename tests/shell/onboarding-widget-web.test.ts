// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GettingStartedVisibilityProvider, useGettingStartedVisibility } from "@matrix-os/ui";
import { OnboardingWidgetHost } from "@/components/onboarding-widget/OnboardingWidgetHost";
import { useWindowManager } from "@/hooks/useWindowManager";
import { CanonicalShellChatRequestError } from "@/lib/canonical-chat-client";
import { isShellSupportOpen, subscribeShellSupportPanel } from "@/lib/posthog-client";
import {
  createShellOnboardingAiPort,
  createShellOnboardingChatPort,
  createShellOnboardingRepoSource,
  isShellComputerStarting,
  isShellNotFound,
  shellOnboardingIdentity,
} from "@/components/onboarding-widget/shell-onboarding-ports";
import { useShellOnboardingIntegrations } from "@/components/onboarding-widget/use-shell-onboarding-integrations";

// The shared gateway socket is not under test here; the widget only subscribes to it.
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true, subscribe: () => () => undefined, send: () => undefined }) }));

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
  window.history.replaceState({}, "", "/");
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

  function hostScene(client: QueryClient, accountId: string | null = "user_a") {
    return createElement(
      QueryClientProvider,
      { client },
      createElement(OnboardingWidgetHost, { accountId, onOpenChat: vi.fn(), onOpenSettings: vi.fn() }),
    );
  }

  function renderHost() {
    return render(hostScene(new QueryClient({ defaultOptions: { queries: { retry: false } } })));
  }

  it("re-reads identity and keeps prefs apart when another account signs in", async () => {
    stubGateway();
    const gateway = vi.mocked(fetch);
    const answer = gateway.getMockImplementation()!;
    let identityReads = 0;
    gateway.mockImplementation(async (input) => {
      if (!String(input).endsWith("/api/identity")) return answer(input);
      identityReads += 1;
      return json(identityReads === 1 ? { handle: "sahar", displayName: "Sahar K" } : { handle: "nima", displayName: "Nima R" });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(hostScene(client, "user_a"));
    await screen.findByText(/Sahar/);

    view.rerender(hostScene(client, "user_b"));
    expect(await screen.findByText(/Nima/)).toBeTruthy();
    expect(identityReads).toBe(2);
    expect(Object.keys(localStorage)).toEqual(expect.arrayContaining([
      "matrix:onboarding-widget:v1:user_a:sahar:primary",
      "matrix:onboarding-widget:v1:user_b:nima:primary",
    ]));
  });

  it("stays on the computer the page loaded on when Shared with me changes the URL", async () => {
    stubGateway();
    window.history.replaceState({}, "", "/vm/alice");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(hostScene(client));
    await screen.findByText(/Sahar/);
    const greeting = screen.getByText(/Sahar/);

    window.history.replaceState({}, "", "/shared");
    view.rerender(hostScene(client));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const identityReads = vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith("/api/identity"));
    expect(identityReads).toEqual([`${window.location.origin}/vm/alice/api/identity`]);
    expect(screen.getByText(/Sahar/)).toBe(greeting);
  });

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

  it("retries a failed identity read instead of keeping the fallback owner", async () => {
    stubGateway();
    const gateway = vi.mocked(fetch);
    const answer = gateway.getMockImplementation()!;
    let identityReads = 0;
    gateway.mockImplementation(async (input) => {
      if (String(input).endsWith("/api/identity") && ++identityReads === 1) return json({ error: "busy" }, 503);
      return answer(input);
    });
    renderHost();
    expect(await screen.findByText(/Sahar/, undefined, { timeout: 4_000 })).toBeTruthy();
    expect(identityReads).toBe(2);
  });

  it("uses the fallback owner when this computer has no identity route", async () => {
    stubGateway();
    const gateway = vi.mocked(fetch);
    const answer = gateway.getMockImplementation()!;
    gateway.mockImplementation(async (input) => (String(input).endsWith("/api/identity") ? json({ error: "Not Found" }, 404) : answer(input)));
    const { container } = renderHost();
    await waitFor(() => expect(container.querySelector(".mxo-root")).not.toBeNull());
    expect(screen.queryByText(/Sahar/)).toBeNull();
  });

  it("holds back the Getting Started auto-open from first render until it unmounts", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Probe() {
      return createElement("output", null, String(useGettingStartedVisibility().autoOpenSuppressed));
    }
    const scene = (showHost: boolean) => createElement(
      QueryClientProvider,
      { client },
      createElement(
        GettingStartedVisibilityProvider,
        { scope: "test" },
        showHost ? createElement(OnboardingWidgetHost, { accountId: "user_a", onOpenChat: vi.fn(), onOpenSettings: vi.fn() }) : null,
        createElement(Probe),
      ),
    );
    const view = render(scene(true));
    expect(screen.getByRole("status").textContent).toBe("true");
    view.rerender(scene(false));
    expect(screen.getByRole("status").textContent).toBe("false");
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

  it("asks the chat client for an older page when the run is not on the newest one", async () => {
    const detail = vi.fn().mockResolvedValue({ runs: [] });
    const port = createShellOnboardingChatPort({ detail } as never);
    await port.detail("chat_1");
    await port.detail("chat_1", "chatcur_older");
    expect(detail.mock.calls).toEqual([["chat_1", undefined], ["chat_1", "chatcur_older"]]);
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

  it("stops downloading a repo list once it passes the size limit", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulled = 0;
    const cancel = vi.fn();
    // An endless body with no Content-Length: only reading with a limit can end this.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += chunk.byteLength; controller.enqueue(chunk); },
      cancel,
    });
    const source = createShellOnboardingRepoSource(GATEWAY, vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(source.listComputerRepos(20, new AbortController().signal)).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
    expect(pulled).toBeLessThanOrEqual(512 * 1024 + 3 * chunk.byteLength);
  });

  it("refuses a repo list whose declared size is over the limit without reading it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(8)); } });
    const response = new Response(body, { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } });
    const source = createShellOnboardingRepoSource(GATEWAY, vi.fn().mockResolvedValue(response));
    await expect(source.readGithubApp({ service: "github", action: "list_repos", label: "sahar", connectionId: "conn_1", params: { sort: "updated", per_page: 20 } }, new AbortController().signal)).rejects.toThrow();
    expect(pulled).toBeLessThanOrEqual(1);
  });
});

describe("web onboarding AI port", () => {
  it("keeps Claude and Codex sign-in on the computer the widget opened after Shared with me", async () => {
    window.history.replaceState({}, "", "/vm/alice");
    const gatewayUrl = `${window.location.origin}/vm/alice`;
    const fetchFn = vi.fn().mockResolvedValue(json([]));
    const port = createShellOnboardingAiPort(gatewayUrl, fetchFn);
    window.history.replaceState({}, "", "/shared");

    await expect(port.client.capabilities(new AbortController().signal)).resolves.toEqual([]);
    expect(String(fetchFn.mock.calls[0]![0])).toBe(`${gatewayUrl}/api/ai/provider-settings/workflows/v2/capabilities`);
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

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.succeeded", service: "github" }));
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe("https://consent.example.test/github");
    expect(result.current.connectingService).toBeNull();
    expect(result.current.connections.map((connection) => connection.id)).toEqual(["conn_1"]);
  });

  it("stops waiting and offers Try again as soon as the consent window is closed", async () => {
    const popup = { ...popupStub(), closed: false };
    vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/integrations/available")) return json(services);
      if (url.endsWith("/api/integrations")) return json([]);
      if (url.endsWith("/api/integrations/connect")) return json({ url: "https://consent.example.test/github" });
      if (url.endsWith("/api/integrations/sync")) { popup.closed = true; return json({ services: [] }); }
      throw new Error(`unexpected ${url}`);
    });
    const dispatch = vi.fn();
    // A long second interval: only the closed window can end the attempt in time.
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0, 0, 600_000] }));
    await waitFor(() => expect(result.current.available).toHaveLength(1));

    act(() => result.current.connectApp("github"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed", service: "github" }));
    expect(result.current.connectingService).toBeNull();
    expect(dispatch).not.toHaveBeenCalledWith({ type: "connect.succeeded", service: "github" });
  });

  it("still confirms a sign-in whose page closed its own window", async () => {
    const popup = { ...popupStub(), closed: false };
    vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/integrations/available")) return json(services);
      if (url.endsWith("/api/integrations")) return json([]);
      if (url.endsWith("/api/integrations/connect")) return json({ url: "https://consent.example.test/github" });
      if (url.endsWith("/api/integrations/sync")) {
        popup.closed = true;
        return json({ services: [{ id: "conn_1", service: "github", account_label: "sahar", status: "active" }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0, 0] }));
    await waitFor(() => expect(result.current.available).toHaveLength(1));

    act(() => result.current.connectApp("github"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.succeeded", service: "github" }));
    expect(dispatch).not.toHaveBeenCalledWith({ type: "connect.failed", service: "github" });
  });

  it("fails without a request when the browser blocks the popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFn = vi.fn(async () => json([]));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0] }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));

    act(() => result.current.connectApp("github"));
    expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed", service: "github" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.current.connectingService).toBeNull();
  });

  it("refuses a malformed app id before opening a window or sending a request", async () => {
    vi.spyOn(window, "open");
    const fetchFn = vi.fn(async () => json([]));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0] }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));

    act(() => result.current.connectApp("../admin"));
    expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed", service: "../admin" });
    expect(window.open).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("closes the popup and fails when the consent URL is not HTTPS", async () => {
    const popup = popupStub();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFn = vi.fn(async (url: string) => (url.endsWith("/connect") ? json({ url: "javascript:alert(1)" }) : json([])));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0] }));

    act(() => result.current.connectApp("github"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed", service: "github" }));
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
    expect(dispatch).toHaveBeenCalledWith({ type: "connect.unavailable", service: "github" });
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
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.unavailable", service: "github" }));
    expect(dispatch).not.toHaveBeenCalledWith({ type: "connect.failed", service: "github" });
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
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed", service: "github" }));
    expect(popup.close).toHaveBeenCalled();
    expect(result.current.appsUnavailable).toBe(false);
  });

  it("keeps polling until the new app finishes signing in, including an account reconnecting", async () => {
    popupStub();
    const syncs = [
      [{ id: "conn_old", service: "gmail", status: "auth_required" }, { id: "conn_new", service: "github", status: "auth_required" }],
      [{ id: "conn_old", service: "gmail", status: "auth_required" }, { id: "conn_new", service: "github", status: "active" }],
      [{ id: "conn_old", service: "gmail", status: "active" }, { id: "conn_new", service: "github", status: "active" }],
    ];
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/integrations/available")) return json(services);
      if (url.endsWith("/api/integrations")) return json([{ id: "conn_old", service: "gmail", status: "auth_required" }]);
      if (url.endsWith("/api/integrations/connect")) return json({ url: "https://consent.example.test/app" });
      if (url.endsWith("/api/integrations/sync")) return json({ services: syncs.shift() ?? [] });
      throw new Error(`unexpected ${url}`);
    });
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0, 0, 0] }));
    await waitFor(() => expect(result.current.connections).toHaveLength(1));

    act(() => result.current.connectApp("github"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.succeeded", service: "github" }));
    expect(syncs).toHaveLength(1);

    act(() => result.current.connectApp("gmail"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.succeeded", service: "gmail" }));
  });

  it("retries the app list a bounded number of times after a server error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let listReads = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/integrations/available")) return ++listReads === 1 ? json({ error: "busy" }, 503) : json(services);
      return json([]);
    });
    const { result } = renderHook(() => useShellOnboardingIntegrations(vi.fn(), { gatewayUrl: GATEWAY, fetchFn, listRetryDelays: [0, 0] }));
    await waitFor(() => expect(result.current.available).toHaveLength(1));
    expect(listReads).toBe(2);

    let outageReads = 0;
    const outage = vi.fn(async (url: string) => {
      if (url.endsWith("/api/integrations/available")) outageReads += 1;
      return json({ error: "busy" }, 503);
    });
    renderHook(() => useShellOnboardingIntegrations(vi.fn(), { gatewayUrl: GATEWAY, fetchFn: outage, listRetryDelays: [0, 0] }));
    await waitFor(() => expect(outageReads).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outageReads).toBe(3);
  });

  it("re-reads connections when Settings connects or disconnects an app, and stops listening on unmount", async () => {
    let connected: unknown[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/integrations/available")) return json(services);
      if (url.endsWith("/api/integrations")) return json(connected);
      throw new Error(`unexpected ${url}`);
    });
    let onChange: (() => void) | null = null;
    const unsubscribe = vi.fn();
    const subscribeConnectionChanges = vi.fn((listener: () => void) => { onChange = listener; return unsubscribe; });
    const { result, unmount } = renderHook(() => useShellOnboardingIntegrations(vi.fn(), { gatewayUrl: GATEWAY, fetchFn, subscribeConnectionChanges }));
    await waitFor(() => expect(result.current.available).toHaveLength(1));
    expect(result.current.connections).toEqual([]);

    connected = [{ id: "conn_1", service: "github", account_label: "sahar", status: "active" }];
    act(() => onChange!());
    await waitFor(() => expect(result.current.connections.map((connection) => connection.id)).toEqual(["conn_1"]));

    connected = [];
    act(() => onChange!());
    await waitFor(() => expect(result.current.connections).toEqual([]));

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("ends on the newest list when Settings connects then disconnects an app while a refresh is still loading", async () => {
    // Every list read after the initial load waits until the test releases it, in order.
    const pending: Array<(response: Response) => void> = [];
    let listReads = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/integrations/available")) return json(services);
      if (url.endsWith("/api/integrations")) {
        listReads += 1;
        if (listReads === 1) return json([]);
        return new Promise<Response>((resolve) => { pending.push(resolve); });
      }
      throw new Error(`unexpected ${url}`);
    });
    let onChange: (() => void) | null = null;
    const subscribeConnectionChanges = (listener: () => void) => { onChange = listener; return () => undefined; };
    const { result } = renderHook(() => useShellOnboardingIntegrations(vi.fn(), { gatewayUrl: GATEWAY, fetchFn, subscribeConnectionChanges }));
    await waitFor(() => expect(result.current.available).toHaveLength(1));

    act(() => onChange!()); // Settings connected GitHub.
    act(() => onChange!()); // Settings disconnected it again while that refresh was still loading.
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    // The older read (still connected) answers first, the newer one (disconnected) after it.
    await act(async () => { pending.shift()!(json([{ id: "conn_1", service: "github", account_label: "sahar", status: "active" }])); });
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    await act(async () => { pending.shift()!(json([])); });

    await waitFor(() => expect(result.current.connections).toEqual([]));
  });

  it("keeps a newer synced connection when an older list read finishes after it", async () => {
    popupStub();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let releaseStaleList: (response: Response) => void = () => undefined;
    let listReads = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/integrations/available")) return json(services);
      if (url.endsWith("/api/integrations")) {
        listReads += 1;
        if (listReads === 1) return json({ error: "busy" }, 503);
        return new Promise<Response>((resolve) => { releaseStaleList = resolve; });
      }
      if (url.endsWith("/api/integrations/connect")) return json({ url: "https://consent.example.test/github" });
      if (url.endsWith("/api/integrations/sync")) return json({ services: [{ id: "conn_1", service: "github", status: "active" }] });
      throw new Error(`unexpected ${url}`);
    });
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0], listRetryDelays: [0] }));
    await waitFor(() => expect(listReads).toBe(2));

    act(() => result.current.connectApp("github"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.succeeded", service: "github" }));
    await act(async () => { releaseStaleList(json([])); });
    expect(result.current.connections.map((connection) => connection.id)).toEqual(["conn_1"]);
  });

  it("gives up when the connection never lands", async () => {
    popupStub();
    const fetchFn = vi.fn(async (url: string) => (url.endsWith("/connect") ? json({ url: "https://consent.example.test/github" }) : json([])));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: [0, 0] }));

    act(() => result.current.connectApp("github"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed", service: "github" }));
    expect(result.current.connectingService).toBeNull();
  });
});
