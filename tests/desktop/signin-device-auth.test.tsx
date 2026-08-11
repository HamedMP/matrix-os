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
  });

  it("presents one browser approval action instead of provider-specific authentication", async () => {
    vi.mocked(invoke)
      .mockResolvedValue(undefined as never)
      .mockResolvedValueOnce({
        userCode: "ABCD-EFGH",
        verificationUri: "https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH",
        expiresIn: 2700,
      } as never);

    render(<SignIn />);

    expect(screen.getByText(/sign in or create an account in your browser/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
    expect(screen.queryByText(/or continue with email/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenNthCalledWith(1, "auth:start-device-flow", {});
      expect(invoke).toHaveBeenNthCalledWith(2, "shell:open-external", {
        url: "https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH",
      });
    });
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open approval page" })).toBeTruthy();
  });
});
