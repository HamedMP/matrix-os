import { describe, expect, it } from "vitest";
import { getThemeVariables } from "../../shell/src/lib/os-bridge";

describe("app theme color scheme", () => {
  it.each(["light", "dark"])("forwards the selected %s scheme to app controls", (colorScheme) => {
    const style = { colorScheme, getPropertyValue: () => "" } as unknown as CSSStyleDeclaration;
    expect(getThemeVariables(style)["--matrix-color-scheme"]).toBe(colorScheme);
  });
  it("leaves an unresolved automatic scheme unset instead of guessing from the device", () => {
    const style = { colorScheme: "normal", getPropertyValue: () => "" } as unknown as CSSStyleDeclaration;
    expect(getThemeVariables(style)["--matrix-color-scheme"]).toBeUndefined();
  });
});
