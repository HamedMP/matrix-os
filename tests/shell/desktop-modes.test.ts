// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useDesktopMode, type DesktopMode } from "../../shell/src/stores/desktop-mode.js";

describe("Desktop Mode Store", () => {
  beforeEach(() => {
    useDesktopMode.setState({ mode: "desktop" });
  });

  it("defaults to 'desktop' mode", () => {
    expect(useDesktopMode.getState().mode).toBe("desktop");
  });

  it("setMode changes the active mode", () => {
    useDesktopMode.getState().setMode("ambient");
    expect(useDesktopMode.getState().mode).toBe("ambient");
  });

  it("supports all 4 modes", () => {
    const modes: DesktopMode[] = ["desktop", "ambient", "dev", "conversational"];
    for (const mode of modes) {
      useDesktopMode.getState().setMode(mode);
      expect(useDesktopMode.getState().mode).toBe(mode);
    }
  });

  it("getModeConfig returns correct config for desktop mode", () => {
    const config = useDesktopMode.getState().getModeConfig("desktop");
    expect(config.label).toBe("Desktop");
    expect(config.showDock).toBe(true);
    expect(config.showWindows).toBe(true);
    expect(config.chatPosition).toBe("sidebar");
  });

  it("getModeConfig returns correct config for ambient mode", () => {
    const config = useDesktopMode.getState().getModeConfig("ambient");
    expect(config.label).toBe("Ambient");
    expect(config.showDock).toBe(false);
    expect(config.showWindows).toBe(false);
    expect(config.chatPosition).toBe("center");
  });

  it("getModeConfig returns correct config for dev mode", () => {
    const config = useDesktopMode.getState().getModeConfig("dev");
    expect(config.label).toBe("Dev");
    expect(config.showDock).toBe(true);
    expect(config.showWindows).toBe(true);
    expect(config.chatPosition).toBe("sidebar");
    expect(config.terminalProminent).toBe(true);
  });

  it("getModeConfig returns correct config for conversational mode", () => {
    const config = useDesktopMode.getState().getModeConfig("conversational");
    expect(config.label).toBe("Conversational");
    expect(config.showDock).toBe(false);
    expect(config.showWindows).toBe(false);
    expect(config.chatPosition).toBe("center");
  });

  it("allModes returns all 4 modes", () => {
    const modes = useDesktopMode.getState().allModes();
    expect(modes).toHaveLength(4);
    expect(modes.map((m) => m.id)).toEqual(["desktop", "ambient", "dev", "conversational"]);
  });
});
