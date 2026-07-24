// @vitest-environment jsdom

// Component tests for the desktop Plugins hub Matrix CLI install card. The
// card is static, truthful content: the Homebrew formula ships in
// homebrew-tap/Formula/matrix.rb ("brew install finnaai/tap/matrix") and the
// npm fallback is the published "@finnaai/matrix" package. Copy buttons use
// navigator.clipboard with generic failure copy.
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLI_BREW_INSTALL_COMMAND,
  CLI_NPM_INSTALL_COMMAND,
  CliSection,
} from "../../desktop/src/renderer/src/features/plugins";

describe("desktop plugins CLI install card", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    writeText.mockClear();
    writeText.mockImplementation(async () => undefined);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the brew and npm install commands plus what the CLI does", () => {
    render(<CliSection />);
    expect(screen.getByText(CLI_BREW_INSTALL_COMMAND)).not.toBeNull();
    expect(screen.getByText(CLI_NPM_INSTALL_COMMAND)).not.toBeNull();
    expect(screen.getByText(/terminal/i)).not.toBeNull();
  });

  it("copies the brew command to the clipboard", async () => {
    render(<CliSection />);
    fireEvent.click(screen.getByTestId("plugins-cli-copy-brew"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CLI_BREW_INSTALL_COMMAND));
    await waitFor(() => expect(screen.getByText("Copied")).not.toBeNull());
  });

  it("copies the npm command to the clipboard", async () => {
    render(<CliSection />);
    fireEvent.click(screen.getByTestId("plugins-cli-copy-npm"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CLI_NPM_INSTALL_COMMAND));
  });

  it("shows generic copy when the clipboard write fails", async () => {
    writeText.mockImplementation(async () => {
      throw new Error("denied");
    });
    render(<CliSection />);
    fireEvent.click(screen.getByTestId("plugins-cli-copy-brew"));
    await waitFor(() =>
      expect(screen.getByText("Could not copy to the clipboard.")).not.toBeNull(),
    );
  });
});
