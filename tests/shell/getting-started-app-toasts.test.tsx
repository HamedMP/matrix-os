// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const providerProps = vi.hoisted(() => ({ current: null as null | { onToast?(text: string): void } }));
vi.mock("@matrix-os/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@matrix-os/ui")>();
  return {
    ...actual,
    GettingStartedAppProvider: (props: { onToast?(text: string): void; children?: React.ReactNode }) => {
      providerProps.current = props;
      return <>{props.children}</>;
    },
  };
});

import { WebGettingStartedAppHost } from "../../shell/src/components/getting-started-app/web-getting-started-app";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderHost() {
  const noop = () => undefined;
  return render(
    <WebGettingStartedAppHost onOpenSettings={noop} onOpenWork={noop} onOpenSupport={noop} onOpenApp={noop} onEnabledChange={noop}>
      <div />
    </WebGettingStartedAppHost>,
  );
}

describe("Web Getting started toasts", () => {
  it("shows each completion when several land between polls, then clears them", () => {
    vi.useFakeTimers();
    renderHost();
    act(() => {
      providerProps.current?.onToast?.("Slack connected +20 pts");
      providerProps.current?.onToast?.("GitHub connected +20 pts");
    });
    expect(screen.getByText("Slack connected +20 pts")).toBeTruthy();
    expect(screen.getByText("GitHub connected +20 pts")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(4_100); });
    expect(screen.queryByText("Slack connected +20 pts")).toBeNull();
    expect(screen.queryByText("GitHub connected +20 pts")).toBeNull();
  });

  it("keeps at most three toasts, newest last", () => {
    vi.useFakeTimers();
    renderHost();
    act(() => {
      for (const name of ["One", "Two", "Three", "Four"]) providerProps.current?.onToast?.(`${name} +20 pts`);
    });
    expect(screen.queryByText("One +20 pts")).toBeNull();
    expect(screen.getAllByText(/\+20 pts/).map((node) => node.textContent)).toEqual(["Two +20 pts", "Three +20 pts", "Four +20 pts"]);
  });
});
