import { describe, expect, it } from "vitest";
import {
  nativeTabOsViewPath,
  nativeOsViewPatch,
} from "@desktop/renderer/src/features/desktop-shell/native-os-view-persistence";

describe("Electron Desktop OS-view persistence projection", () => {
  it("uses the same canonical built-in paths as Web Desktop", () => {
    expect(nativeTabOsViewPath({ id: "chat", kind: "work", title: "Chat", closable: false }, [])).toBe("__chat__");
    expect(nativeTabOsViewPath({ id: "files", kind: "files", title: "Files", closable: false }, [])).toBe("__file-browser__");
    expect(nativeTabOsViewPath({ id: "term", kind: "terminal", title: "Terminal", sessionName: "calm-cedar", closable: true }, []))
      .toBe("__terminal__:calm-cedar");
  });

  it("projects app state separately from Desktop geometry", () => {
    const tab = { id: "chat", kind: "work" as const, title: "Chat", closable: false };
    const patch = nativeOsViewPatch({
      tabs: [tab],
      surfaces: {
        chat: {
          tabId: "chat",
          mode: "minimized",
          restoreMode: "window",
          bounds: { x: 12, y: 18, width: 900, height: 640 },
          zIndex: 10,
        },
      },
      installedApps: [],
      mode: "desktop",
      canonicalGeometry: {
        __chat__: { x: 200, y: 160, width: 900, height: 640 },
      },
    });

    expect(patch.apps).toEqual([{ path: "__chat__", title: "Chat", state: "minimized" }]);
    expect(patch.desktop?.windows).toEqual([
      { path: "__chat__", x: 200, y: 160, width: 900, height: 640 },
    ]);
  });
});
