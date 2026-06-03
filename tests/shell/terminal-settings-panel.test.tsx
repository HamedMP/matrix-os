// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TerminalSettingsPanel } from "../../shell/src/components/terminal/TerminalMenuBarControls.js";
import { useTerminalSettings } from "../../shell/src/stores/terminal-settings.js";

describe("TerminalSettingsPanel", () => {
  beforeEach(() => {
    useTerminalSettings.setState({
      themeId: "system",
      fontSize: 13,
      fontFamily: "MesloLGS NF",
      ligatures: true,
      cursorStyle: "block",
      smoothScroll: true,
      cursorBlink: true,
    });
  });

  it("updates theme and font from the app settings surface", () => {
    render(<TerminalSettingsPanel />);

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "nord" } });
    fireEvent.change(screen.getByLabelText("Font"), { target: { value: "Fira Code" } });

    expect(useTerminalSettings.getState()).toMatchObject({
      themeId: "nord",
      fontFamily: "Fira Code",
    });
  });
});
