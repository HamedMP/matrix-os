// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DeveloperModeDashboard } from "../../shell/src/components/developer/DeveloperModeDashboard.js";

describe("DeveloperModeDashboard", () => {
  it("presents Terminal first, Symphony second, setup status, and Canvas as an explicit switch", () => {
    const onOpenTerminal = vi.fn();
    const onOpenSymphony = vi.fn();
    const onSwitchCanvas = vi.fn();

    render(
      <DeveloperModeDashboard
        setupPrompt="Install Matrix CLI, run matrix login, then matrix run -it --session setup -- gh auth login."
        onOpenTerminal={onOpenTerminal}
        onOpenSymphony={onOpenSymphony}
        onSwitchCanvas={onSwitchCanvas}
      />,
    );

    expect(screen.getByRole("heading", { name: /developer mode/i })).toBeTruthy();
    expect(screen.getByText(/Terminal is the primary surface/i)).toBeTruthy();
    expect(screen.getByText(/Symphony is next/i)).toBeTruthy();
    expect(screen.getAllByText(/Matrix-managed SSH key/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Do not upload local private keys/i)).toBeTruthy();
    expect(screen.getByDisplayValue(/matrix run -it --session setup -- gh auth login/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /open terminal/i }));
    fireEvent.click(screen.getByRole("button", { name: /open symphony/i }));
    fireEvent.click(screen.getByRole("button", { name: /switch to canvas/i }));

    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(onOpenSymphony).toHaveBeenCalledTimes(1);
    expect(onSwitchCanvas).toHaveBeenCalledTimes(1);
  });
});
