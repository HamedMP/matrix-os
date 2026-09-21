// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("desktop device authorization sign-in", () => {
  beforeEach(() => {
    useConnection.setState(useConnection.getInitialState(), true);
    useConnection.setState({ refresh: vi.fn(async () => undefined) });
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("presents explicit desktop-first account creation and sign-in actions", async () => {
    vi.mocked(invoke)
      .mockResolvedValue(undefined as never)
      .mockResolvedValueOnce({
        userCode: "ABCD-EFGH",
        verificationUri: "https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH",
        expiresIn: 2700,
      } as never);

    render(<SignIn />);

    expect(screen.getByText(/create your account or sign in securely in your browser/i)).toBeTruthy();
    expect(screen.getByText(/3 days by default/i)).toBeTruthy();
    expect(screen.getByText(/Stripe Checkout confirms eligibility/i)).toBeTruthy();
    expect(screen.queryByText(/New hosted accounts include a 3-day free trial/i)).toBeNull();
    expect(screen.getByText(/returns you to Matrix Desktop automatically/i)).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "Open approval page" })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "Open approval page" })).toBeTruthy();
  });
});
