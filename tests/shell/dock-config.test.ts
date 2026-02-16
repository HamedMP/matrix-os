import { describe, it, expect, beforeEach } from "vitest";
import { useDesktopConfigStore } from "../../shell/src/stores/desktop-config";

describe("Desktop config store", () => {
  beforeEach(() => {
    useDesktopConfigStore.setState({
      dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
    });
  });

  it("initializes with default dock config", () => {
    const { dock } = useDesktopConfigStore.getState();
    expect(dock.position).toBe("left");
    expect(dock.size).toBe(56);
    expect(dock.iconSize).toBe(40);
    expect(dock.autoHide).toBe(false);
  });

  it("setDock updates position", () => {
    const { setDock, dock } = useDesktopConfigStore.getState();
    setDock({ ...dock, position: "bottom" });
    expect(useDesktopConfigStore.getState().dock.position).toBe("bottom");
  });

  it("setDock updates size", () => {
    const { setDock, dock } = useDesktopConfigStore.getState();
    setDock({ ...dock, size: 72 });
    expect(useDesktopConfigStore.getState().dock.size).toBe(72);
  });

  it("setDock updates iconSize", () => {
    const { setDock, dock } = useDesktopConfigStore.getState();
    setDock({ ...dock, iconSize: 48 });
    expect(useDesktopConfigStore.getState().dock.iconSize).toBe(48);
  });

  it("setDock updates autoHide", () => {
    const { setDock, dock } = useDesktopConfigStore.getState();
    setDock({ ...dock, autoHide: true });
    expect(useDesktopConfigStore.getState().dock.autoHide).toBe(true);
  });
});
