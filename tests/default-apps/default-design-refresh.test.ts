// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultApp } from "../../home/apps/_shared/default-apps";

afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(window, "MatrixOS"); });

describe("default app refresh actions", () => {
  it("runs, pauses and resets a session-only focus timer", async () => {
    vi.useFakeTimers();
    render(React.createElement(DefaultApp, { id: "pomodoro" }));
    expect(screen.getByRole("timer").textContent).toBe("25:00");
    fireEvent.click(screen.getByRole("button", { name: "Start focus" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole("timer").textContent).toBe("24:59");
    fireEvent.click(screen.getByRole("button", { name: "Pause focus" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("timer").textContent).toBe("24:59");
    fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
    expect(screen.getByRole("timer").textContent).toBe("25:00");
    expect(screen.getByText(/resets when you close/i)).toBeTruthy();
  });
  it("reconciles elapsed time on foreground and announces completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    render(React.createElement(DefaultApp, { id: "pomodoro" }));
    fireEvent.click(screen.getByRole("button", { name: "Short break" }));
    expect(screen.getByRole("timer").textContent).toBe("05:00");
    fireEvent.click(screen.getByRole("button", { name: "Start focus" }));
    vi.setSystemTime(new Date("2026-10-07T10:06:00Z"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByRole("timer").textContent).toBe("00:00");
    expect(screen.getByRole("status").textContent).toContain("Session complete");
    expect(screen.getByRole("button", { name: "Start focus" }).hasAttribute("disabled")).toBe(true);
    Reflect.deleteProperty(document, "visibilityState");
  });
  it("launches games at their real nested paths", () => {
    const openApp = vi.fn();
    Object.defineProperty(window, "MatrixOS", { configurable: true, value: { openApp } });
    render(React.createElement(DefaultApp, { id: "games" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Chess" }));
    expect(openApp).toHaveBeenCalledWith("Chess", "apps/games/chess/index.html");
    expect(screen.queryByText("12")).toBeNull();
  });
  it("explains launch unavailability without an inert button", () => {
    render(React.createElement(DefaultApp, { id: "games" }));
    expect(screen.getByRole("button", { name: "Play Chess" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Open Game Center inside Matrix/i)).toBeTruthy();
  });
  it("does not invent profile/social statistics or publishing", () => {
    const { unmount } = render(React.createElement(DefaultApp, { id: "profile" }));
    expect(screen.getByText(/No profile data connected/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit profile" })).toBeNull();
    unmount();
    render(React.createElement(DefaultApp, { id: "social" }));
    expect(screen.getByText(/No feed connected/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });
});
