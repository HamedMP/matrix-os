// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionSurface } from "../../desktop/src/renderer/src/features/companion/CompanionSurface";

describe("CompanionSurface", () => {
  const invoke = vi.fn(async () => ({ ok: true }));

  beforeEach(() => {
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
  });

  afterEach(() => {
    cleanup();
    invoke.mockClear();
  });

  it("expands the rabbit into a compact Hermes composer", async () => {
    render(<CompanionSurface />);

    fireEvent.click(screen.getByRole("button", { name: "Ask Hermes" }));

    expect(await screen.findByRole("textbox", { name: "Message Hermes" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("companion:set-expanded", { expanded: true });
  });

  it("hands a bounded prompt to the trusted main process and collapses", async () => {
    render(<CompanionSurface />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Hermes" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message Hermes" }), {
      target: { value: "Summarize my active work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to Hermes" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("companion:submit-prompt", {
        prompt: "Summarize my active work",
      });
    });
    expect(await screen.findByText("Sent to Hermes")).toBeTruthy();
  });

  it("can focus Matrix OS or hide the rabbit without exposing raw Electron APIs", () => {
    render(<CompanionSurface />);

    fireEvent.click(screen.getByRole("button", { name: "Open Matrix OS" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Ask Hermes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide rabbit" }));

    expect(invoke).toHaveBeenCalledWith("companion:focus-main", {});
    expect(invoke).toHaveBeenCalledWith("companion:hide", {});
  });
});
