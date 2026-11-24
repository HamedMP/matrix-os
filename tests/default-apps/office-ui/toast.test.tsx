// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import React, { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast, type ToastApi } from "../../../home/apps/_shared/office-ui";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(): { api: () => ToastApi } {
  let captured: ToastApi | null = null;
  function Capture() {
    captured = useToast();
    return null;
  }
  render(
    <StrictMode>
      <ToastProvider>
        <Capture />
      </ToastProvider>
    </StrictMode>,
  );
  return { api: () => captured! };
}

describe("ToastProvider", () => {
  it("keeps at most five toasts, evicting the oldest, and auto-dismisses the rest", () => {
    vi.useFakeTimers();
    const { api } = mount();
    act(() => {
      for (let i = 1; i <= 6; i++) api().show({ title: `Toast ${i}` });
    });
    expect(screen.queryByText("Toast 1")).toBeNull();
    for (let i = 2; i <= 6; i++) expect(screen.getByText(`Toast ${i}`)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText(/Toast \d/)).toBeNull();
  });

  it("dismisses one toast by id and keeps a sticky one until dismissed", () => {
    vi.useFakeTimers();
    const { api } = mount();
    let sticky = "";
    act(() => {
      api().show({ title: "Saved" });
      sticky = api().show({ title: "Changed on disk", durationMs: 0 });
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByText("Changed on disk")).toBeTruthy();
    act(() => api().dismiss(sticky));
    expect(screen.queryByText("Changed on disk")).toBeNull();
  });
});
