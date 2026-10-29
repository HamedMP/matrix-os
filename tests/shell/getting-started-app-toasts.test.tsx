// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const providerProps = vi.hoisted(() => ({ current: null as null | { onToast?(toast: { title: string; points: number }): void } }));
vi.mock("@matrix-os/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@matrix-os/ui")>();
  return {
    ...actual,
    GettingStartedAppProvider: (props: { onToast?(toast: { title: string; points: number }): void; children?: React.ReactNode }) => {
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
