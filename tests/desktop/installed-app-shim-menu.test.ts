import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { shimMenuTemplate } from "@desktop/main/installed-apps/shim-menu";

describe("app shim menu", () => {
  it("gives the shim's app menu Reload, Open in Matrix, Show in Finder and Uninstall…, wired to their actions", () => {
    const actions = { reload: vi.fn(), openInMatrix: vi.fn(), showInFinder: vi.fn(), uninstall: vi.fn() };
    const template = shimMenuTemplate("Notes", actions);
    const appMenu = template[0]!;
    expect(appMenu.label).toBe("Notes");
    const items = appMenu.submenu as MenuItemConstructorOptions[];
    const byLabel = (label: string) => items.find((item) => item.label === label)!;
    for (const [label, action] of [["Reload", actions.reload], ["Open in Matrix", actions.openInMatrix],
      ["Show in Finder", actions.showInFinder], ["Uninstall…", actions.uninstall]] as const) {
      (byLabel(label).click as () => void)();
      expect(action).toHaveBeenCalledOnce();
    }
    expect(items.at(-1)).toEqual({ role: "quit" });
  });

  it("keeps editing and window shortcuts, which Matrix's own menu does not provide inside a shim", () => {
    const template = shimMenuTemplate("Notes", { reload() {}, openInMatrix() {}, showInFinder() {}, uninstall() {} });
    expect(template.slice(1)).toEqual([{ role: "editMenu" }, { role: "windowMenu" }]);
  });

  it("names the app menu as Finder and the Dock do, anti-spoof suffix included", () => {
    const actions = { reload() {}, openInMatrix() {}, showInFinder() {}, uninstall() {} };
    expect(shimMenuTemplate("Matrix Settings", actions)[0]!.label).toBe("Matrix Settings (Matrix App)");
    expect(shimMenuTemplate("Notes.app", actions)[0]!.label).toBe("Notes");
  });
});
