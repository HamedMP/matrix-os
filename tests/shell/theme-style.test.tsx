// @vitest-environment jsdom
import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useThemeStyle } from "../../shell/src/components/window/useThemeStyle.js";

describe("useThemeStyle", () => {
  it("reads the active document theme on the first client render", () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    const renderedStyles: string[] = [];

    function ThemeProbe() {
      const style = useThemeStyle();
      renderedStyles.push(style);
      return <span>{style}</span>;
    }

    render(<ThemeProbe />);

    expect(renderedStyles[0]).toBe("winxp");
  });
});
