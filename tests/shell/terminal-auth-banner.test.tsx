// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalAuthBanner } from "../../shell/src/components/terminal/TerminalAuthBanner.js";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

const CODEX_DEVICE_LINK = {
  provider: "codex" as const,
  providerLabel: "Codex" as const,
  url: "https://auth.openai.com/codex/device",
};

describe("TerminalAuthBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    if (originalExecCommandDescriptor) {
      Object.defineProperty(document, "execCommand", originalExecCommandDescriptor);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("opens a detected login URL outside the terminal", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<TerminalAuthBanner link={CODEX_DEVICE_LINK} color="#c2703a" onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open login" }));

    expect(screen.getByText("Codex login required")).toBeTruthy();
    expect(open).toHaveBeenCalledWith(
      "https://auth.openai.com/codex/device",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("copies a detected login URL without selecting TUI output", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<TerminalAuthBanner link={CODEX_DEVICE_LINK} color="#c2703a" onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));

    expect(writeText).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
  });

  it("falls back to document copy when the Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<TerminalAuthBanner link={CODEX_DEVICE_LINK} color="#c2703a" onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await Promise.resolve();

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
