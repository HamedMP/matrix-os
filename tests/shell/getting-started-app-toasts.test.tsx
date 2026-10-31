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
const viewProps = vi.hoisted(() => ({ current: null as null | { onAction(action: unknown): void } }));
const connections = vi.hoisted(() => ({
  connectApp: vi.fn(),
  connectingService: "gmail" as string | null,
  failedServices: new Set<string>(["slack"]) as ReadonlySet<string>,
  appsUnavailable: false,
}));
vi.mock("next/navigation", () => ({ usePathname: () => window.location.pathname }));
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
    GettingStartedAppView: (props: { onAction(action: unknown): void }) => {
      viewProps.current = props;
      return null;
    },
  };
});

import { WebGettingStartedAppHost, WebGettingStartedAppWindow } from "../../shell/src/components/getting-started-app/web-getting-started-app";
import { webGettingStartedAppVisible } from "../../shell/src/components/getting-started-app/web-getting-started-app-port";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderHost(onOpenSettings: (section: string) => void = () => undefined) {
  const noop = () => undefined;
  return render(
    <WebGettingStartedAppHost onOpenSettings={onOpenSettings} onOpenWork={noop} onOpenSupport={noop} onOpenApp={noop} onEnabledChange={noop}>
      <WebGettingStartedAppWindow />
    </WebGettingStartedAppHost>,
  );
}

describe("Web Getting started app across computers", () => {
  afterEach(() => window.history.pushState({}, "", "/"));

  it("starts clean if the computer changes without a page load", () => {
    const view = renderHost();
    const firstPort = providerProps.current?.port;
    view.rerender(
      <WebGettingStartedAppHost onOpenSettings={() => undefined} onOpenWork={() => undefined} onOpenSupport={() => undefined} onOpenApp={() => undefined} onEnabledChange={() => undefined}>
        <WebGettingStartedAppWindow />
      </WebGettingStartedAppHost>,
    );
    expect(providerProps.current?.port).toBe(firstPort);
    window.history.pushState({}, "", "/vm/pv-other/");
    view.rerender(
      <WebGettingStartedAppHost onOpenSettings={() => undefined} onOpenWork={() => undefined} onOpenSupport={() => undefined} onOpenApp={() => undefined} onEnabledChange={() => undefined}>
        <WebGettingStartedAppWindow />
      </WebGettingStartedAppHost>,
    );
    expect(providerProps.current?.port).not.toBe(firstPort);
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
