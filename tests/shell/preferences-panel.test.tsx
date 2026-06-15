// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPreferencesPanel } from "../../shell/src/components/terminal/preferences-panel.js";
import { useTerminalSettings } from "../../shell/src/stores/terminal-settings.js";

describe("TerminalPreferencesPanel", () => {
  beforeEach(() => {
    useTerminalSettings.setState({
      themeId: "dark",
      fontSize: 13,
      fontFamily: "JetBrains Mono",
      ligatures: true,
      cursorStyle: "block",
      smoothScroll: true,
      cursorBlink: true,
    });
  });

  it("updates theme, font, ligatures, cursor style, and smooth scroll settings", () => {
    render(<TerminalPreferencesPanel />);

    expect(screen.getByRole("option", { name: "MesloLGS NF" })).toBeTruthy();

    expect(screen.getByRole("option", { name: "Dark" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Light" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Matrix" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Dracula" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "matrix" } });
    fireEvent.change(screen.getByLabelText("Font"), { target: { value: "MesloLGS NF" } });
    fireEvent.click(screen.getByLabelText("Ligatures"));
    fireEvent.change(screen.getByLabelText("Cursor"), { target: { value: "bar" } });
    fireEvent.click(screen.getByLabelText("Smooth scroll"));

    expect(useTerminalSettings.getState()).toMatchObject({
      themeId: "matrix",
      fontFamily: "MesloLGS NF",
      ligatures: false,
      cursorStyle: "bar",
      smoothScroll: false,
    });
  });

  it("does not replace the active terminal theme when preferences are opened", async () => {
    useTerminalSettings.setState({ themeId: "dracula" });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        preferences: {
          themeId: "system",
          fontFamily: "MesloLGS NF",
          ligatures: true,
          cursorStyle: "block",
          smoothScroll: true,
        },
      }),
    })));

    render(<TerminalPreferencesPanel sessionName="main" />);
    await Promise.resolve();
    await Promise.resolve();

    expect(useTerminalSettings.getState().themeId).toBe("dracula");
  });
});
