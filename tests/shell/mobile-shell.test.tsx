// @vitest-environment jsdom

import React from "react";
import { renderToString } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileAppSurface } from "../../shell/src/components/mobile/MobileAppSurface.js";
import { MobileLauncher } from "../../shell/src/components/mobile/MobileLauncher.js";
import { useMobileViewport } from "../../shell/src/hooks/useMobileViewport.js";
import { createShellSnapshotScope, saveShellSnapshot } from "../../shell/src/lib/shell-snapshot-cache.js";
import { setDesktopViewport, setPhoneViewport } from "./mobile-shell-test-utils.js";

let fileChangeHandler: ((path: string, event: "add" | "change" | "unlink") => void) | null = null;

vi.mock("../../shell/src/hooks/useFileWatcher.js", () => ({
  useFileWatcher: (handler: typeof fileChangeHandler) => {
    fileChangeHandler = handler;
  },
}));

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: ({ launchTargetId }: { launchTargetId?: string }) => (
    <div data-testid="terminal-app">
      <input
        aria-label="Command composer"
        onFocus={() => window.dispatchEvent(new CustomEvent("matrixos:terminal-input-active", {
          detail: { active: true, terminalId: launchTargetId ?? "mock-terminal" },
        }))}
        onBlur={() => window.dispatchEvent(new CustomEvent("matrixos:terminal-input-active", {
          detail: { active: false, terminalId: launchTargetId ?? "mock-terminal" },
        }))}
      />
    </div>
  ),
}));

vi.mock("../../shell/src/components/Settings.js", () => ({
  Settings: () => null,
}));

vi.mock("sonner", () => ({
  toast: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  PricingTable: () => <div data-testid="pricing-table" />,
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    has: () => false,
  }),
  useUser: () => ({
    user: {
      fullName: null,
      username: "test-user",
      imageUrl: "",
      primaryEmailAddress: { emailAddress: "test@example.com" },
    },
  }),
  useClerk: () => ({
    signOut: vi.fn(async () => undefined),
    openUserProfile: vi.fn(),
  }),
  UserButton: Object.assign(
    ({ children }: { children?: React.ReactNode }) => <div data-testid="clerk-user-button">{children}</div>,
    {
      MenuItems: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
      Link: ({ href, label }: { href: string; label: string; labelIcon?: React.ReactElement }) => <a href={href}>{label}</a>,
    },
  ),
}));

vi.mock("@/hooks/useTheme", () => ({
  DEFAULT_THEME: {
    name: "test",
    mode: "dark",
    colors: { background: "#111111", foreground: "#ffffff" },
    fonts: {},
    radius: "8px",
  },
  useTheme: () => ({ mode: "dark", colors: {}, fonts: {} }),
}));

function ViewportProbe() {
  const mobile = useMobileViewport();
  return <div data-testid="viewport-mode">{mobile ? "mobile" : "desktop"}</div>;
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

async function loadMobileShell() {
  return (await import("../../shell/src/components/mobile/MobileShell.js")).MobileShell;
}

describe("mobile shell", () => {
  beforeEach(() => {
    fileChangeHandler = null;
    const storage = createMemoryStorage();
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
    });
    setDesktopViewport();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses launcher-first mode on phone-sized browser viewports", async () => {
    setPhoneViewport();

    render(<ViewportProbe />);

    await waitFor(() => expect(screen.getByTestId("viewport-mode").textContent).toBe("mobile"));
  });

  it("initializes phone mode synchronously on the client", () => {
    setPhoneViewport();

    render(<ViewportProbe />);

    expect(screen.getByTestId("viewport-mode").textContent).toBe("mobile");
  });

  it("updates viewport mode when a phone viewport expands", () => {
    setPhoneViewport();
    render(<ViewportProbe />);

    act(() => {
      setDesktopViewport();
    });

    expect(screen.getByTestId("viewport-mode").textContent).toBe("desktop");
  });

  it("opens apps from the mobile launcher and shows active app state", () => {
    const onOpenApp = vi.fn();

    render(
      <MobileLauncher
        apps={[{ name: "Notes", path: "apps/notes/index.html" }]}
        openWindowPaths={new Set(["apps/notes/index.html"])}
        onOpenApp={onOpenApp}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-launcher-app-apps/notes/index.html"));

    expect(onOpenApp).toHaveBeenCalledWith("Notes", "apps/notes/index.html");
    expect(screen.getByLabelText("Open")).toBeTruthy();
  });

  it("offers an explicit resume action for the last mobile app", () => {
    const onResumeApp = vi.fn();

    render(
      <MobileLauncher
        apps={[
          { name: "Notes", path: "apps/notes/index.html" },
          { name: "Tasks", path: "__workspace__" },
        ]}
        openWindowPaths={new Set()}
        onOpenApp={vi.fn()}
        resumeApp={{ name: "Notes", path: "apps/notes/index.html" }}
        onResumeApp={onResumeApp}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-resume-app"));

    expect(onResumeApp).toHaveBeenCalledWith("Notes", "apps/notes/index.html");
  });

  it("returns home from a full-screen mobile app without unmounting content", () => {
    const onHome = vi.fn();

    render(
      <MobileAppSurface title="Notes" onHome={onHome}>
        <div data-testid="runtime-content">runtime</div>
      </MobileAppSurface>,
    );

    fireEvent.click(screen.getByTestId("mobile-home-button"));

    expect(onHome).toHaveBeenCalled();
    expect(screen.getByTestId("runtime-content")).toBeTruthy();
  });

  it("keeps app content inside the mobile surface viewport", () => {
    render(
      <MobileAppSurface title="Terminal" onHome={vi.fn()}>
        <div data-testid="terminal-content" className="h-full w-full overflow-hidden" />
      </MobileAppSurface>,
    );

    expect(screen.getByTestId("mobile-app-surface").className).toContain("overflow");
    expect(screen.getByTestId("terminal-content")).toBeTruthy();
  });

  it("shows a safe fallback when a restored mobile app is missing", () => {
    render(
      <MobileAppSurface title="Missing app" onHome={vi.fn()} unavailableMessage="Open the app from the launcher again." />,
    );

    expect(screen.getByText("App unavailable")).toBeTruthy();
    expect(screen.getByText("Open the app from the launcher again.")).toBeTruthy();
  });

  it("caps live terminal instances opened from the mobile dock", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => [],
    })));
    const MobileShell = await loadMobileShell();

    render(<MobileShell />);

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      for (let i = 0; i < 7; i += 1) {
        fireEvent.click(screen.getByLabelText("Terminal"));
      }
    });
    act(() => {
      fireEvent.click(screen.getByLabelText("Open"));
    });

    expect(screen.getAllByLabelText("Close Terminal")).toHaveLength(5);
  });

  it("opens a launch shortcut target inside the mobile shell", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => [],
    })));
    const MobileShell = await loadMobileShell();

    render(<MobileShell launchAppPath="__terminal__" />);

    await waitFor(() => expect(screen.getByTestId("terminal-app")).toBeTruthy());
  });

  it("hides the bottom dock while the terminal command composer is focused", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => [],
    })));
    const MobileShell = await loadMobileShell();

    render(<MobileShell launchAppPath="__terminal__" />);

    await waitFor(() => expect(screen.getByTestId("terminal-app")).toBeTruthy());

    const dock = screen.getByTestId("mobile-bottom-dock");
    expect(dock.style.display).toBe("flex");

    fireEvent.focus(screen.getByRole("textbox", { name: "Command composer" }));

    expect(dock.style.display).toBe("none");

    act(() => {
      window.dispatchEvent(new CustomEvent("matrixos:terminal-input-active", {
        detail: { active: false, terminalId: "background-terminal" },
      }));
    });

    expect(dock.style.display).toBe("none");

    fireEvent.blur(screen.getByRole("textbox", { name: "Command composer" }));

    expect(dock.style.display).toBe("flex");
  });

  it("loads installed mobile apps from the shared shell bootstrap endpoint", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({
        layout: { windows: [] },
        modules: [],
        apps: [{ name: "Notes", path: "/files/apps/notes/index.html", icon: "notes", slug: "notes" }],
        icons: { notes: { url: "/icons/notes.png", etag: "\"abc\"", versionedUrl: "/icons/notes.png?v=abc" } },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const MobileShell = await loadMobileShell();

    render(<MobileShell />);

    expect(await screen.findByTestId("mobile-launcher-app-apps/notes/index.html")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/shell/bootstrap");
  });

  it("replaces design-scoped launcher apps when theme.json changes", async () => {
    let apps = [
      { name: "XP Minesweeper", path: "/files/apps/winxp-minesweeper/index.html", icon: "minesweeper" },
    ];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({ layout: { windows: [] }, modules: [], apps, icons: {} }),
    })));
    const MobileShell = await loadMobileShell();
    render(<MobileShell />);

    expect(await screen.findByTestId("mobile-launcher-app-apps/winxp-minesweeper/index.html")).toBeTruthy();

    apps = [
      { name: "Sticky Notes", path: "/files/apps/win-sticky-notes/index.html", icon: "sticky-notes" },
    ];
    await act(async () => {
      fileChangeHandler?.("system/theme.json", "change");
      await Promise.resolve();
    });

    expect(await screen.findByTestId("mobile-launcher-app-apps/win-sticky-notes/index.html")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("mobile-launcher-app-apps/winxp-minesweeper/index.html")).toBeNull();
    });
  });

  it("ignores an older bootstrap response after a newer theme refresh wins", async () => {
    let resolveInitial: ((response: Response) => void) | undefined;
    let resolveThemeRefresh: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveInitial = resolve;
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveThemeRefresh = resolve;
      }));
    vi.stubGlobal("fetch", fetchMock);
    const MobileShell = await loadMobileShell();
    render(<MobileShell />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => {
      fileChangeHandler?.("system/theme.json", "change");
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    resolveThemeRefresh?.({
      ok: true,
      json: async () => ({
        layout: { windows: [] },
        modules: [],
        apps: [{ name: "Sticky Notes", path: "/files/apps/win-sticky-notes/index.html" }],
        icons: {},
      }),
    } as Response);
    expect(await screen.findByTestId("mobile-launcher-app-apps/win-sticky-notes/index.html")).toBeTruthy();

    resolveInitial?.({
      ok: true,
      json: async () => ({
        layout: { windows: [] },
        modules: [],
        apps: [{ name: "XP Minesweeper", path: "/files/apps/winxp-minesweeper/index.html" }],
        icons: {},
      }),
    } as Response);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("mobile-launcher-app-apps/win-sticky-notes/index.html")).toBeTruthy();
    expect(screen.queryByTestId("mobile-launcher-app-apps/winxp-minesweeper/index.html")).toBeNull();
  });

  it("hydrates installed mobile apps from the scoped shell snapshot before network refresh", async () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();
    saveShellSnapshot(scope, {
      bootstrap: {
        layout: { windows: [] },
        modules: [],
        apps: [{ name: "Cached Notes", path: "/files/apps/notes/index.html", icon: "notes", slug: "notes" }],
        icons: { notes: { url: "/icons/notes.png", etag: "\"abc\"", versionedUrl: "/icons/notes.png?v=abc" } },
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const MobileShell = await loadMobileShell();

    render(<MobileShell cacheScope={scope} />);

    expect(screen.getByTestId("mobile-launcher-app-apps/notes/index.html")).toBeTruthy();
  });

  it("renders a hydration-stable clock placeholder before mounting", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => [],
    })));
    const MobileShell = await loadMobileShell();

    expect(renderToString(<MobileShell />)).toContain("--:--");
  });
});
