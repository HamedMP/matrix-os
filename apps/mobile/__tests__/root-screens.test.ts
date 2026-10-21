import { ROOT_SCREEN_OPTIONS } from "../lib/root-screens";

describe("how the root screens come and go", () => {
  it("cross-fades between the startup gate and the shell instead of sliding", () => {
    expect(ROOT_SCREEN_OPTIONS.index).toMatchObject({ animation: "fade" });
    expect(ROOT_SCREEN_OPTIONS["(drawer)"]).toMatchObject({ animation: "fade" });
  });

  it("pushes the settings pages as pages, which go back with a swipe from the edge", () => {
    for (const name of ["settings-detail", "integration-detail"] as const) {
      expect(ROOT_SCREEN_OPTIONS[name]).not.toHaveProperty("presentation");
      expect(ROOT_SCREEN_OPTIONS[name]).not.toHaveProperty("gestureEnabled");
    }
  });

  it("raises files and installed integrations as sheets, which close with a swipe down", () => {
    expect(ROOT_SCREEN_OPTIONS["file-browser"]).toMatchObject({ presentation: "modal" });
    expect(ROOT_SCREEN_OPTIONS["integrations-installed"]).toMatchObject({ presentation: "modal" });
  });

  it("keeps the terminal and app previews full screen, where a swipe belongs to what is inside", () => {
    expect(ROOT_SCREEN_OPTIONS["terminal-session"]).toMatchObject({ presentation: "fullScreenModal" });
    expect(ROOT_SCREEN_OPTIONS["app-preview"]).toMatchObject({ presentation: "fullScreenModal" });
    const fullScreen = Object.entries(ROOT_SCREEN_OPTIONS)
      .filter(([, options]) => "presentation" in options && options.presentation === "fullScreenModal")
      .map(([name]) => name);
    expect(fullScreen.sort()).toEqual(["app-preview", "terminal-session"]);
  });

  it("draws no navigator header over any of them; each draws its own", () => {
    for (const options of Object.values(ROOT_SCREEN_OPTIONS)) {
      expect(options.headerShown).toBe(false);
    }
  });
});
