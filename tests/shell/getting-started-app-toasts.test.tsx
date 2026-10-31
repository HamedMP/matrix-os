// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type ProviderProps = {
  port?: unknown;
  onToast?(toast: { title: string; points: number }): void;
  connections?: { connectingService: string | null; failedServices: readonly string[]; changeCount: number };
  children?: React.ReactNode;
};
const providerProps = vi.hoisted(() => ({ current: null as null | ProviderProps }));
const appState = vi.hoisted(() => ({ current: null as null | { enabled: boolean; availability: string } }));
const viewProps = vi.hoisted(() => ({ current: null as null | { onAction(action: unknown): void } }));
const connections = vi.hoisted(() => ({
  connectApp: vi.fn(),
  connectingService: "gmail" as string | null,
  failedServices: new Set<string>(["slack"]) as ReadonlySet<string>,
  appsUnavailable: false,
}));
vi.mock("../../shell/src/components/onboarding/use-getting-started-connections", () => ({
  useGettingStartedConnections: () => connections,
}));
vi.mock("@matrix-os/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@matrix-os/ui")>();
  return {
    ...actual,
    GettingStartedAppProvider: (props: ProviderProps) => {
      providerProps.current = props;
      return <>{props.children}</>;
    },
    useGettingStartedApp: () => appState.current,
    GettingStartedAppView: (props: { onAction(action: unknown): void }) => {
      viewProps.current = props;
      return null;
    },
  };
});

import { WebGettingStartedAppHost, WebGettingStartedAppWindow } from "../../shell/src/components/getting-started-app/web-getting-started-app";
import { webGettingStartedAppVisible, webGettingStartedWindowOnScreen } from "../../shell/src/components/getting-started-app/web-getting-started-app-port";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function hostElement(onOpenSettings: (section: string) => void = () => undefined) {
  const noop = () => undefined;
  return (
    <WebGettingStartedAppHost onOpenSettings={onOpenSettings} onOpenWork={noop} onOpenSupport={noop} onOpenApp={noop} onEnabledChange={noop}>
      <WebGettingStartedAppWindow />
    </WebGettingStartedAppHost>
  );
}

function renderHost(onOpenSettings?: (section: string) => void) {
  return render(hostElement(onOpenSettings));
}

describe("Web Getting started app across navigation", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
    vi.unstubAllGlobals();
    appState.current = null;
  });

  it("stays on its computer when shared navigation drops the /vm prefix from the URL", async () => {
    window.history.pushState({}, "", "/vm/pv-one/?runtime=slot-a");
    const view = renderHost();
    const port = providerProps.current?.port as { loadProgress(signal?: AbortSignal): Promise<unknown>; loadResults(signal: AbortSignal): Promise<unknown> };
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ awards: [], total: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    window.history.pushState({}, "", "/shared/chat/abc");
    view.rerender(hostElement());
    expect(providerProps.current?.port).toBe(port);
    await port.loadProgress();
    await port.loadResults(new AbortController().signal);
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls.filter((value) => value.includes("/api/"))) expect(url).toContain("/vm/pv-one/~runtime/slot-a/api/");
    expect(urls.find((value) => value.includes("/billing/status"))).toContain("runtimeSlot=slot-a");
  });

  it("does not say the app is unavailable while it is still checking", () => {
    appState.current = { enabled: false, availability: "checking" };
    renderHost();
    expect(screen.queryByText(/not available on this computer/)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Loading");
  });

  it("says the app is unavailable once the computer turns out not to serve it", () => {
    appState.current = { enabled: false, availability: "unavailable" };
    renderHost();
    expect(screen.getByText(/not available on this computer/)).toBeTruthy();
  });
});

describe("Web Getting started app sign-ins", () => {
  it("starts an app's own sign-in from a card and shares its state with the app", () => {
    const onOpenSettings = vi.fn();
    renderHost(onOpenSettings);
    expect(providerProps.current?.connections).toEqual({ connectingService: "gmail", failedServices: ["slack"], changeCount: 0 });
    act(() => viewProps.current?.onAction({ type: "connect", service: "google_calendar" }));
    expect(connections.connectApp).toHaveBeenCalledWith("google_calendar");
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("opens Settings instead when this computer has no app connection service", () => {
    connections.appsUnavailable = true;
    const onOpenSettings = vi.fn();
    renderHost(onOpenSettings);
    act(() => viewProps.current?.onAction({ type: "connect", service: "gmail" }));
    expect(onOpenSettings).toHaveBeenCalledWith("integrations");
    connections.appsUnavailable = false;
  });
});

describe("Web Getting started toasts", () => {
  it("shows each completion when several land between polls, then clears them", () => {
    vi.useFakeTimers();
    renderHost();
    act(() => {
      providerProps.current?.onToast?.({ title: "Slack connected", points: 20 });
      providerProps.current?.onToast?.({ title: "GitHub connected", points: 20 });
    });
    expect(screen.getByLabelText("Slack connected +20 pts")).toBeTruthy();
    expect(screen.getByLabelText("GitHub connected +20 pts")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(4_100); });
    expect(screen.queryByLabelText("Slack connected +20 pts")).toBeNull();
    expect(screen.queryByLabelText("GitHub connected +20 pts")).toBeNull();
  });

  it("keeps at most three toasts, newest last", () => {
    vi.useFakeTimers();
    renderHost();
    act(() => {
      for (const name of ["One", "Two", "Three", "Four"]) providerProps.current?.onToast?.({ title: name, points: 20 });
    });
    expect(screen.queryByLabelText("One +20 pts")).toBeNull();
    expect(screen.getAllByLabelText(/\+20 pts/).map((node) => node.getAttribute("aria-label"))).toEqual(["Two +20 pts", "Three +20 pts", "Four +20 pts"]);
  });
});

describe("Getting started app visibility on Web Desktop and Web Canvas", () => {
  it("counts an open window as showing", () => {
    expect(webGettingStartedAppVisible({ id: "gs", minimized: false }, null)).toBe(true);
    expect(webGettingStartedAppVisible({ id: "gs", minimized: false }, "gs")).toBe(true);
  });

  it("does not count a minimized window", () => {
    expect(webGettingStartedAppVisible({ id: "gs", minimized: true }, null)).toBe(false);
  });

  it("does not count a window covered by another fullscreen window", () => {
    expect(webGettingStartedAppVisible({ id: "gs", minimized: false }, "terminal")).toBe(false);
  });
});

describe("Getting started app on the Web Canvas", () => {
  const win = { x: 100, y: 100, width: 400, height: 300 };
  const view = { zoom: 1, panX: 0, panY: 0, viewportWidth: 1000, viewportHeight: 800 };

  it("counts a window in view as on screen, at any zoom", () => {
    expect(webGettingStartedWindowOnScreen(win, view)).toBe(true);
    expect(webGettingStartedWindowOnScreen(win, { ...view, panX: -450 })).toBe(true);
    expect(webGettingStartedWindowOnScreen(win, { ...view, zoom: 0.5, panX: 1500 })).toBe(true);
  });

  it("does not count a window panned out of view, so awards go to the corner toast", () => {
    expect(webGettingStartedWindowOnScreen(win, { ...view, panX: -600 })).toBe(false);
    expect(webGettingStartedWindowOnScreen(win, { ...view, panX: 1000 })).toBe(false);
    expect(webGettingStartedWindowOnScreen(win, { ...view, panY: -500 })).toBe(false);
    expect(webGettingStartedWindowOnScreen(win, { ...view, panY: 800 })).toBe(false);
  });
});
