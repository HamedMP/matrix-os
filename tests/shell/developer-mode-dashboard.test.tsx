// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeveloperModeDashboard } from "../../shell/src/components/developer/DeveloperModeDashboard.js";

describe("DeveloperModeDashboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("presents Terminal first, setup status, and Canvas as an explicit switch", () => {
    const onOpenTerminal = vi.fn();
    const onSwitchCanvas = vi.fn();

    render(
      <DeveloperModeDashboard
        setupPrompt="Install Matrix CLI, run matrix login, then matrix run -it --session setup -- gh auth login."
        onOpenTerminal={onOpenTerminal}
        onSwitchCanvas={onSwitchCanvas}
      />,
    );

    expect(screen.getByRole("heading", { name: /developer mode/i })).toBeTruthy();
    expect(screen.getByText(/Terminal is the primary surface/i)).toBeTruthy();
    expect(screen.queryByText(/Symphony/i)).toBeNull();
    expect(screen.getAllByText(/Matrix-managed SSH key/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Do not upload local private keys/i)).toBeTruthy();
    expect(screen.getByDisplayValue(/matrix run -it --session setup -- gh auth login/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /open terminal/i }));
    fireEvent.click(screen.getByRole("button", { name: /switch to canvas/i }));

    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(onSwitchCanvas).toHaveBeenCalledTimes(1);
  });

  it("logs clipboard failures instead of silently swallowing them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("permission denied")),
      },
    });

    render(
      <DeveloperModeDashboard
        setupPrompt="matrix login"
        onOpenTerminal={vi.fn()}
        onSwitchCanvas={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith("[DeveloperModeDashboard] clipboard write failed:", "permission denied");
    });
  });
});
