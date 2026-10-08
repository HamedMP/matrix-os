// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SignIn from "../../desktop/src/renderer/src/features/signin/SignIn";
import { invoke } from "../../desktop/src/renderer/src/lib/operator";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

vi.mock("../../desktop/src/renderer/src/assets/matrix-logo.svg", () => ({
  default: "matrix-logo.svg",
}));

vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({
  invoke: vi.fn(),
}));

describe("Electron Desktop device authorization sign-in", () => {
  beforeEach(() => {
    useConnection.setState(useConnection.getInitialState(), true);
    useConnection.setState({ refresh: vi.fn(async () => { useConnection.setState({ status: "signed-in" }); }) });
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("welcomes users with branded account actions and plain browser handoff copy", async () => {
    vi.mocked(invoke)
      .mockResolvedValue(undefined as never)
      .mockResolvedValueOnce({
        userCode: "ABCD-EFGH",
        verificationUri: "https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH",
        expiresIn: 2700,
      } as never);

    render(<SignIn />);

    expect(screen.getByRole("heading", { name: "Welcome to Matrix OS" })).toBeTruthy();
    expect(screen.getByText(/continue securely in your browser/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/electron|VPS|Stripe|3.day/i);
    expect(screen.queryByText(/New hosted accounts include a 3-day free trial/i)).toBeNull();
    expect(screen.getByText(/come back here automatically/i)).toBeTruthy();
    expect(screen.queryByText(/Matrix Desktop/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
    expect(screen.queryByText(/or continue with email/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenNthCalledWith(1, "auth:start-device-flow", { intent: "sign-up" });
      expect(invoke).toHaveBeenNthCalledWith(2, "shell:open-external", {
        url: "https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH",
      });
    });
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open browser again" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/electron/i);
  });

  it("opens the existing-account Clerk route without changing the secure device flow", async () => {
    vi.mocked(invoke)
      .mockResolvedValue(undefined as never)
      .mockResolvedValueOnce({
        userCode: "ABCD-EFGH",
        verificationUri: "https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH&mode=sign-in",
        expiresIn: 2700,
      } as never);

    render(<SignIn />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenNthCalledWith(1, "auth:start-device-flow", { intent: "sign-in" });
      expect(invoke).toHaveBeenNthCalledWith(2, "shell:open-external", {
        url: "https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH&mode=sign-in",
      });
    });
  });

  it("records a sanitized diagnostic when the approval page cannot open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(invoke)
      .mockResolvedValue(undefined as never)
      .mockResolvedValueOnce({
        userCode: "ABCD-EFGH",
        verificationUri: "https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH",
        expiresIn: 2700,
      } as never)
      .mockRejectedValueOnce(new Error("sensitive operating-system details"));

    render(<SignIn />);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "[signin] browser approval open failed",
        "Error",
      );
    });
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("sensitive operating-system details"),
    );
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open browser again" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't open your browser/i);
  });

  it("keeps the chosen action busy and prevents duplicate requests", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => undefined));
    render(<SignIn />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((screen.getByRole("button", { name: "Opening browser…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("catches browser retry failures without exposing operating-system details", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(invoke)
      .mockResolvedValue(undefined as never)
      .mockResolvedValueOnce({ userCode: "ABCD-EFGH", verificationUri: "https://app.matrix-os.com/auth/device", expiresIn: 2700 } as never);
    render(<SignIn />);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText("ABCD-EFGH");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("/private/sensitive/path"));
    fireEvent.click(screen.getByRole("button", { name: "Open browser again" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/couldn't open your browser/i));
    expect(document.body.textContent).not.toContain("/private/sensitive/path");
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
  });

  it.each(["expired", "authorized", "error"])("handles %s polling and stops polling afterward", async (status) => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementation(async (channel) => {
      if (channel === "auth:start-device-flow") return { userCode: "ABCD-EFGH", verificationUri: "https://app.matrix-os.com/auth/device", expiresIn: 2700 } as never;
      if (channel === "auth:poll") {
        if (status === "error") throw new Error("network details");
        return { status } as never;
      }
      return undefined as never;
    });
    render(<SignIn />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    if (status === "authorized") expect(useConnection.getState().refresh).toHaveBeenCalledOnce();
    else {
      expect(screen.getByRole("alert").textContent).toMatch(status === "expired" ? /expired/i : /try again/i);
      expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(false);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "auth:poll")).toHaveLength(1);
  });

  it.each(["signed-out", "rejected"])("offers recovery when the approved connection refresh is %s", async (outcome) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useConnection.setState({ refresh: vi.fn(async () => {
      if (outcome === "rejected") throw new Error("/private/sensitive/path");
      useConnection.setState({ status: "signed-out" });
    }) });
    vi.mocked(invoke).mockImplementation(async (channel) => {
      if (channel === "auth:start-device-flow") return { userCode: "ABCD-EFGH", verificationUri: "https://app.matrix-os.com/auth/device", expiresIn: 2700 } as never;
      if (channel === "auth:poll") return { status: "authorized" } as never;
      return undefined as never;
    });
    render(<SignIn />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't connect/i);
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.body.textContent).not.toContain("/private/sensitive/path");
    if (outcome === "rejected") expect(warn).toHaveBeenCalledWith("[signin] approved connection refresh failed", "Error");
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "auth:poll")).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
    expect(vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "auth:start-device-flow")).toHaveLength(2);
  });
});
