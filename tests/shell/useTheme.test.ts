// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_THEME, getThemeFallback, normalizeTheme, resetThemeRuntimeCacheForTests, saveTheme, useTheme, useThemeState, type Theme } from "../../shell/src/hooks/useTheme";
import { createShellSnapshotScope, loadShellSnapshot, saveShellSnapshot } from "../../shell/src/lib/shell-snapshot-cache";

const watcher = vi.hoisted(() => ({ callback: null as null | ((path: string, event: string) => void) }));
vi.mock("../../shell/src/hooks/useFileWatcher", () => ({ useFileWatcher: (callback: typeof watcher.callback) => { watcher.callback = callback; } }));

function themeToCssVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    vars[`--${key}`] = value;
  }
  for (const [key, value] of Object.entries(theme.fonts)) {
    vars[`--font-${key}`] = value;
  }
  vars["--radius"] = theme.radius;
  return vars;
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("theme system", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
    });
    vi.restoreAllMocks();
    resetThemeRuntimeCacheForTests();
    window.history.replaceState({}, "", "/");
    document.documentElement.removeAttribute("data-theme-style");
  });

  const REQUIRED_COLOR_KEYS = [
    "background",
    "foreground",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "destructive",
    "success",
    "warning",
    "border",
    "input",
    "ring",
  ];

  it('does not enable appearance writes before the initial read succeeds', async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const { result } = renderHook(() => useThemeState());
    expect(result.current.loaded).toBe(false);
    await act(async () => { finish({ ok: true, json: async () => ({ name: 'saved', colors: { background: '#112233' } }) }); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.theme.name).toBe('saved');
  });
  it('keeps writes disabled when the initial read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const { result } = renderHook(() => useThemeState());
    await waitFor(() => expect(result.current.loadError).toBe(true));
    expect(result.current.loaded).toBe(false);
  });

  it('completes loading when a file-watch read overtakes the initial read', async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ ok: true, json: async () => ({ ...DEFAULT_THEME, name: 'watched' }) }));
    const { result } = renderHook(() => useThemeState());
    await act(async () => { watcher.callback?.('system/theme.json', 'change'); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.loadError).toBe(false);
    expect(result.current.theme.name).toBe('watched');
    await act(async () => { finish({ ok: true, json: async () => DEFAULT_THEME }); });
    expect(result.current.theme.name).toBe('watched');
  });
  it.each(['tokyo-night', 'solarized', 'catppuccin'])('migrates a retired legacy preset %s while retaining dark mode', name => {
    const result = normalizeTheme({ name, mode: 'dark', colors: { background: '#101010' } });
    expect(result.name).toBe('matrix');
    expect(result.mode).toBe('dark');
    expect(result.appearance?.themeId).toBe('matrix');
    expect(normalizeTheme({ name, mode: 'light', colors: { background: '#101010' } }).mode).toBe('light');
  });
  it("default theme has all required color keys", () => {
    for (const key of REQUIRED_COLOR_KEYS) {
      expect(DEFAULT_THEME.colors[key]).toBeDefined();
    }
  });

  it("default theme has font keys", () => {
    expect(DEFAULT_THEME.fonts.mono).toBeDefined();
    expect(DEFAULT_THEME.fonts.sans).toBeDefined();
  });

  it("uses the light default theme for first-run shell state", () => {
    const theme = getThemeFallback();

    expect(theme).toBe(DEFAULT_THEME);
    expect(theme.colors.background).toBe("#fafafa");
  });

  it("normalizes empty first-run theme responses against the light shell fallback", () => {
    const fallback = getThemeFallback();
    const theme = normalizeTheme({}, fallback);

    expect(theme.mode).toBe("light");
    expect(theme.colors.background).toBe(fallback.colors.background);
  });

  it("normalizes invalid theme responses against the selected fallback", () => {
    const fallback = getThemeFallback();

    expect(normalizeTheme(null, fallback)).toBe(fallback);
    expect(normalizeTheme([], fallback)).toBe(fallback);
  });

  it("preserves explicit saved light themes over the shell fallback", () => {
    const theme = normalizeTheme({
      name: "saved-light",
      mode: "light",
      colors: {
        background: "#ffffff",
        foreground: "#111111",
      },
    });

    expect(theme.mode).toBe("light");
    expect(theme.colors.background).toBe("#ffffff");
    expect(theme.colors.foreground).toBe("#111111");
  });

  it("preserves explicit saved dark themes over the shell fallback", () => {
    const theme = normalizeTheme({
      name: "saved-dark",
      mode: "dark",
      colors: {
        background: "#111111",
        foreground: "#ffffff",
      },
    });

    expect(theme.mode).toBe("dark");
    expect(theme.colors.background).toBe("#111111");
    expect(theme.colors.foreground).toBe("#ffffff");
  });

  it("preserves legacy saved light themes that omit mode", () => {
    const theme = normalizeTheme({
      name: "legacy-light",
      colors: {
        background: "#ffffff",
        foreground: "#111111",
      },
    });

    expect(theme.mode).toBeUndefined();
    expect(theme.colors.background).toBe("#ffffff");
    expect(theme.colors.foreground).toBe("#111111");
  });

  it("converts theme to CSS variables", () => {
    const vars = themeToCssVars(DEFAULT_THEME);
    expect(vars["--background"]).toBe("#fafafa");
    expect(vars["--primary"]).toBe("#242323");
    expect(vars["--font-mono"]).toBe('"JetBrains Mono", ui-monospace, monospace');
    expect(vars["--radius"]).toBe("0.5rem");
  });

  it("all color values are valid hex", () => {
    const hexRegex = /^#[0-9a-fA-F]{6}$/;
    for (const [key, value] of Object.entries(DEFAULT_THEME.colors)) {
      expect(value).toMatch(hexRegex);
    }
  });

  it("generates correct number of CSS variables", () => {
    const vars = themeToCssVars(DEFAULT_THEME);
    const colorCount = Object.keys(DEFAULT_THEME.colors).length;
    const fontCount = Object.keys(DEFAULT_THEME.fonts).length;
    expect(Object.keys(vars).length).toBe(colorCount + fontCount + 1);
  });

  it("custom theme overrides apply correctly", () => {
    const custom: Theme = {
      ...DEFAULT_THEME,
      name: "ocean",
      colors: { ...DEFAULT_THEME.colors, background: "#001122", primary: "#00ccff" },
    };
    const vars = themeToCssVars(custom);
    expect(vars["--background"]).toBe("#001122");
    expect(vars["--primary"]).toBe("#00ccff");
    expect(vars["--foreground"]).toBe("#242323");
  });

  it("normalizes missing persisted theme fields to defaults", () => {
    const theme = normalizeTheme({});
    const fallback = getThemeFallback();

    expect(theme.colors.background).toBe(fallback.colors.background);
    expect(theme.colors.foreground).toBe(fallback.colors.foreground);
    expect(theme.fonts.mono).toBe(fallback.fonts.mono);
    expect(theme.radius).toBe(fallback.radius);
  });

  it("normalizes partial persisted themes without dropping valid overrides", () => {
    const fallback = getThemeFallback();
    const theme = normalizeTheme({
      name: "custom",
      mode: "dark",
      colors: {
        background: "#001122",
        primary: "#00ccff",
        ignored: 42,
      },
      fonts: {
        sans: "system-ui, sans-serif",
        ignored: false,
      },
      radius: "1rem",
    });

    expect(theme.name).toBe("custom");
    expect(theme.mode).toBe("dark");
    expect(theme.colors.background).toBe("#001122");
    expect(theme.colors.primary).toBe("#00ccff");
    expect(theme.colors.foreground).toBe(fallback.colors.foreground);
    expect(theme.fonts.sans).toBe("system-ui, sans-serif");
    expect(theme.fonts.mono).toBe(fallback.fonts.mono);
    expect(theme.radius).toBe("1rem");
  });

  it("derives navigation colors for an older saved theme without sidebar tokens", () => {
    const theme = normalizeTheme({ name: "legacy", mode: "dark", colors: { background: "#101010", secondary: "#202020", foreground: "#eeeeee", accent: "#303030" } });
    expect(theme.colors.sidebar).toBe("#202020");
    expect(theme.colors["sidebar-foreground"]).toBe("#eeeeee");
    expect(theme.colors["sidebar-accent"]).toBe("#303030");
  });

  it("initializes from the scoped shell snapshot before revalidating from the server", async () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();
    saveShellSnapshot(scope, {
      theme: {
        ...DEFAULT_THEME,
        name: "cached-dark",
        mode: "dark",
        colors: { ...DEFAULT_THEME.colors, background: "#101010" },
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...DEFAULT_THEME,
        name: "fresh-light",
        mode: "light",
        colors: { ...DEFAULT_THEME.colors, background: "#ffffff" },
      }),
    }));

    const { result } = renderHook(() => useTheme({ cacheScope: scope }));

    expect(result.current.name).toBe("cached-dark");
    expect(result.current.colors.background).toBe("#101010");
    await waitFor(() => expect(result.current.name).toBe("fresh-light"));
    expect(loadShellSnapshot(scope)?.theme?.name).toBe("fresh-light");
  });

  it("keeps the active OS design when a second theme consumer mounts", async () => {
    let keepSecondFetchPending: ((value: never) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...DEFAULT_THEME, name: "xp", style: "winxp" }),
      })
      .mockReturnValueOnce(new Promise((resolve) => {
        keepSecondFetchPending = resolve;
      })));

    const root = renderHook(() => useTheme());
    await waitFor(() => expect(root.result.current.style).toBe("winxp"));
    expect(document.documentElement.getAttribute("data-theme-style")).toBe("winxp");

    const settings = renderHook(() => useTheme());

    expect(settings.result.current.style).toBe("winxp");
    expect(document.documentElement.getAttribute("data-theme-style")).toBe("winxp");
    settings.unmount();
    root.unmount();
    expect(keepSecondFetchPending).toBeTypeOf("function");
  });

  it("updates the scoped shell snapshot only after theme saves succeed", async () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    await saveTheme({ ...DEFAULT_THEME, name: "saved-theme" }, { cacheScope: scope });

    expect(loadShellSnapshot(scope)?.theme?.name).toBe("saved-theme");
  });

  it("does not let an earlier load overwrite a newly saved theme", async () => {
    let resolveLoad!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn()
      .mockReturnValueOnce(new Promise(resolve => { resolveLoad = resolve; }))
      .mockResolvedValueOnce({ ok: true }));
    const hook = renderHook(() => useTheme());
    await act(async () => { await saveTheme({ ...DEFAULT_THEME, name: "saved-custom" }); });
    expect(hook.result.current.name).toBe("saved-custom");
    await act(async () => { resolveLoad({ ok: true, json: async () => DEFAULT_THEME }); });
    expect(hook.result.current.name).toBe("saved-custom");
    hook.unmount();
  });

  describe("theme style validation", () => {
    it.each(["flat", "neumorphic", "macos-glass", "winxp", "win11"])(
      "accepts the %s style during normalization",
      (style) => {
        const theme = normalizeTheme({ name: "styled", style });
        expect(theme.style).toBe(style);
      },
    );

    it("drops unknown styles when the fallback has no style", () => {
      const theme = normalizeTheme({ name: "bad-style", style: "skeuomorphic" });
      expect(theme.style).toBeUndefined();
    });

    it("falls back to the fallback theme style for unknown styles", () => {
      const fallback: Theme = { ...DEFAULT_THEME, style: "win11" };
      const theme = normalizeTheme({ name: "bad-style", style: "aero" }, fallback);
      expect(theme.style).toBe("win11");
    });

    it("applies design-system styles to the root element on save", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      await saveTheme({ ...DEFAULT_THEME, name: "xp", style: "winxp" });

      expect(document.documentElement.getAttribute("data-theme-style")).toBe("winxp");
    });
  });
});
