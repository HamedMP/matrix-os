// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountSection from "../../desktop/src/renderer/src/features/settings/sections/AccountSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

describe("AccountSection", () => {
  beforeEach(() => {
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      displayName: "Ada Operator",
      imageUrl: "https://example.com/avatar.png",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "primary",
      api: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens the same deletion and export page in the system browser", () => {
    render(<AccountSection />);
    fireEvent.click(screen.getByRole("button", { name: "Account data and deletion" }));
    expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", { url: "https://app.matrix-os.com/account/delete" });
  });

  it("renders the native device-flow display profile", () => {
    render(<AccountSection />);

    expect(screen.getByText("Ada Operator")).not.toBeNull();
    expect(screen.getAllByText("@operator").length).toBeGreaterThan(0);
    expect(screen.getByAltText("Ada Operator avatar").getAttribute("src")).toBe(
      "https://example.com/avatar.png",
    );
  });
});
