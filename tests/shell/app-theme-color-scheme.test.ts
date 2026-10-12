// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getThemeVariables } from "../../shell/src/lib/os-bridge";

import { saveTheme, DEFAULT_THEME } from "../../shell/src/hooks/useTheme";
vi.mock("../../shell/src/hooks/useFileWatcher", () => ({ useFileWatcher: vi.fn() }));
vi.mock("../../shell/src/lib/gateway", () => ({ getGatewayUrl: () => "http://localhost:4000" }));
afterEach(() => { vi.unstubAllGlobals(); document.documentElement.style.colorScheme = ""; });

describe("app theme color scheme", () => {
  it.each(["light", "dark"])("applies the chosen %s shell mode to browser controls and app bridges", async (mode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await saveTheme({ ...DEFAULT_THEME, mode: mode as "light" | "dark" });
    expect(document.documentElement.dataset.theme).toBe(mode);
    const computed = getComputedStyle(document.documentElement);
    expect(computed.colorScheme).toBe(mode);
    expect(getThemeVariables(computed)["--matrix-color-scheme"]).toBe(mode);
  });
  it.each(["light", "dark"])("forwards the selected %s scheme to app controls", (colorScheme) => {
    const style = { colorScheme, getPropertyValue: () => "" } as unknown as CSSStyleDeclaration;
    expect(getThemeVariables(style)["--matrix-color-scheme"]).toBe(colorScheme);
  });
  it("leaves an unresolved automatic scheme unset instead of guessing from the device", () => {
    const style = { colorScheme: "normal", getPropertyValue: () => "" } as unknown as CSSStyleDeclaration;
    expect(getThemeVariables(style)["--matrix-color-scheme"]).toBeUndefined();
  });
});
