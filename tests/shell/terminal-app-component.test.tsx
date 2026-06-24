// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

const paneGridSpy = vi.fn();
const { saveThemeSpy } = vi.hoisted(() => ({
  saveThemeSpy: vi.fn(async () => {}),
}));

vi.mock("../../shell/src/components/terminal/PaneGrid.js", () => ({
  PaneGrid: (props: unknown) => {
    paneGridSpy(props);
    return null;
  },
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    name: "matrix-dark",
    mode: "dark",
    colors: { background: "#1C2019", foreground: "#F0EFE5", primary: "#9CB77A" },
    fonts: { mono: "JetBrains Mono, monospace", sans: "Inter, system-ui, sans-serif" },
    radius: "0.75rem",
  }),
  saveTheme: saveThemeSpy,
}));

vi.mock("@/stores/terminal-settings", () => {
  const state = {
    themeId: "system",
    fontSize: 13,
    fontFamily: "JetBrains Mono",
    ligatures: true,
    cursorStyle: "block",
    smoothScroll: true,
    cursorBlink: true,
    setThemeId: vi.fn(),
    setFontSize: vi.fn(),
    setFontFamily: vi.fn(),
    setLigatures: vi.fn(),
    setCursorStyle: vi.fn(),
    setSmoothScroll: vi.fn(),
    setCursorBlink: vi.fn(),
  };
  const useTerminalSettings = (selector: (value: typeof state) => unknown) => selector(state);
  useTerminalSettings.getState = () => state;

  return {
    TERMINAL_FONT_FAMILIES: ["MesloLGS NF", "Berkeley Mono", "JetBrains Mono", "Fira Code"],
    DEFAULT_TERMINAL_THEME_ID: "dark",
    useTerminalSettings,
  };
});

import { TerminalApp } from "../../shell/src/components/terminal/TerminalApp.js";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

async function openNewSessionMenu() {
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  await Promise.resolve();
}

async function chooseNewSessionMenuItem(name: RegExp | string) {
  await openNewSessionMenu();
  const menu = screen.getByRole("menu", { name: "New session menu" });
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
  await Promise.resolve();
  await Promise.resolve();
}

async function chooseNewSessionMenuItemAfterStatus(name: RegExp | string) {
  await openNewSessionMenu();
  const menu = screen.getByRole("menu", { name: "New session menu" });
  const item = await vi.waitFor(() => within(menu).getByRole("menuitem", { name }));
  fireEvent.click(item);
  await vi.waitFor(() => {
    expect(screen.queryByRole("menu", { name: "New session menu" })).toBeNull();
  });
}

function expectedAgentInstallCommand(packageName: string, flags: string[] = []): string {
  const extraFlags = flags.length > 0 ? `${flags.join(" ")} ` : "";
  return [
    'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
    `npm install -g ${extraFlags}--prefix "$MATRIX_NODE_PREFIX" ${packageName}`,
  ].join("; ");
}

function expectOptimizedImageSrc(element: HTMLElement, expectedPath: string): void {
  expect(decodeURIComponent(element.getAttribute("src") ?? "")).toContain(expectedPath);
}

function createDragDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    dropEffect: "move",
    effectAllowed: "move",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: vi.fn((format?: string) => {
      if (format) {
        data.delete(format);
      } else {
        data.clear();
      }
    }),
    getData: vi.fn((format: string) => data.get(format) ?? ""),
    setData: vi.fn((format: string, value: string) => {
      data.set(format, value);
    }),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function revealSessionActions(name: string) {
  const card = screen.getByTestId(`terminal-session-card-${name}`);
  fireEvent.pointerEnter(card);
  fireEvent.pointerMove(card);
  fireEvent.mouseEnter(card);
  fireEvent.mouseMove(card);
}

describe("TerminalApp", () => {
  beforeEach(() => {
    paneGridSpy.mockReset();
    saveThemeSpy.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a canvas-provided terminal session without creating a fresh layout tab", async () => {
    render(<TerminalApp initialSessionId="canvas-session-123" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Canvas Terminal")).toBeTruthy();
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };

    expect(props.paneTree).toMatchObject({
      type: "pane",
      sessionId: "canvas-session-123",
    });
  });

  it("does not immediately save after hydrating a saved terminal layout", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            activeTabId: "tab-saved",
            sidebarOpen: true,
            tabs: [{
              id: "tab-saved",
              label: "Saved",
              paneTree: { type: "pane", id: "pane-saved", cwd: "projects/app" },
            }],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const layoutPutCalls = fetchMock.mock.calls.filter((call) => (
      String(call[0]).includes("/api/terminal/layout") && call[1]?.method === "PUT"
    ));
    expect(layoutPutCalls).toHaveLength(0);
  });

  it("does not render workspace transport ids as managed shell sessions", async () => {
    render(<TerminalApp initialSessionId="matrix-sess_run_db0dded67faaca6b" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("matrix-sess_run_db0dded67faaca6b")).toBeNull();
    expect(screen.queryByRole("button", { name: /close matrix-sess_run_db0dded67faaca6b/i })).toBeNull();
  });

  it("uses its Paper chrome traffic lights for host window controls", async () => {
    const close = vi.fn();
    const minimize = vi.fn();
    const toggleFullscreen = vi.fn();
    render(<TerminalApp windowControls={{ close, minimize, toggleFullscreen }} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal window" }));
    fireEvent.click(screen.getByRole("button", { name: "Minimize Terminal window" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle Terminal fullscreen" }));

    expect(close).toHaveBeenCalledOnce();
    expect(minimize).toHaveBeenCalledOnce();
    expect(toggleFullscreen).toHaveBeenCalledOnce();
  });

  it("keeps the mobile terminal chrome clear of cwd badges that overlap zellij tabs", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("~/projects")).toBeNull();
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
  });

  it("keeps mobile terminal accessory keys theme-aligned and keyboard safe", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const keyBar = screen.getByTestId("terminal-key-bar");
    expect(keyBar.style.position).toBe("sticky");
    expect(keyBar.style.bottom).toBe("var(--matrix-terminal-keybar-bottom)");
    expect(keyBar.style.getPropertyValue("--matrix-terminal-keybar-bottom")).toBe("env(keyboard-inset-height, 0px)");
    expect(keyBar.style.background).toContain("28, 32, 25");
    expect(screen.getByRole("button", { name: "Control C" }).style.color).toContain("240, 239, 229");
    expect(screen.getByRole("button", { name: "Enter" })).toBeTruthy();
  });

  it("does not let mobile terminal clients take ownership of the remote zellij size", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      allowRemoteResize: false,
      suppressNativeKeyboard: true,
    });
  });

  it("renders the redesigned desktop shell with sessions in the drawer instead of top tabs", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("tablist", { name: "Terminal tabs" })).toBeNull();
    expect(screen.getByText("matrixos")).toBeTruthy();
    expect(screen.getByPlaceholderText("Find a session...")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Background")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(screen.queryByText("Zellij")).toBeNull();
  });

  it("opens terminal-only theme preferences without global Matrix OS theme controls", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fetchMock.mockClear();

    const button = screen.getByRole("button", { name: "Theme" });
    expect(button.textContent?.replace(/\s+/g, "")).toBe("☼Theme");
    expect(button.style.height).toBe("34px");
    expect(button.style.borderRadius).toBe("9px");
    expect(button.style.background).toBe("rgb(32, 36, 28)");
    expect(button.style.borderColor).toBe("rgb(45, 49, 39)");

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions/main/preferences"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("dialog", { name: "Shell theme" })).toBeTruthy();
    expect(screen.getByText("Zellij default · best contrast")).toBeTruthy();
    expect(screen.getByText("gruvbox-light")).toBeTruthy();
    expect(screen.getByText("custom · green on black")).toBeTruthy();
    expect(screen.getAllByText("NOT FULLY TUNED")).toHaveLength(2);
    expect(screen.queryByText("Warm paper")).toBeNull();
    expect(screen.queryByText("Warm dark")).toBeNull();
    expect(screen.queryByText("Phosphor green")).toBeNull();
    expect(screen.queryByRole("button", { name: "Match system" })).toBeNull();
    expect(screen.queryByRole("menu", { name: "Theme" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Theme" })).toBeNull();
    expect(saveThemeSpy).not.toHaveBeenCalled();

    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(screen.queryByRole("dialog", { name: "Shell theme" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves terminal shell theme preferences to the session-scoped API", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fetchMock.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Theme" }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions/main/preferences"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("dialog", { name: "Shell theme" })).toBeTruthy();
    expect(screen.getByText("Zellij default · best contrast")).toBeTruthy();
    expect(screen.getByText("gruvbox-light")).toBeTruthy();
    expect(screen.getByText("custom · green on black")).toBeTruthy();
    expect(screen.getAllByText("NOT FULLY TUNED")).toHaveLength(2);
    expect(screen.queryByRole("combobox", { name: "Theme" })).toBeNull();
    expect(saveThemeSpy).not.toHaveBeenCalled();

    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Light gruvbox-light" }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions/main/preferences"),
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("\"shellThemeId\":\"light\""),
      }),
    );
  });

  it("copies Matrix shell connect commands from session rows", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("matrix shell connect")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy connect command for matrix-main" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy Matrix shell connect command for matrix-main" })).toBeNull();
    const row = screen.getByRole("button", { name: "Open matrix-main" }).closest(".group");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);
    const actions = screen.getByTestId("terminal-session-actions-main");
    const copyButton = screen.getByTestId("terminal-session-copy-button-main");
    expect(row!.style.display).toBe("grid");
    expect(row!.style.gridTemplateColumns).toBe("minmax(0, 1fr) 46px");
    expect(actions.style.width).toBe("58px");
    expect(actions.style.position).toBe("absolute");
    expect(actions.style.right).toBe("0px");
    expect(actions.style.top).toBe("50%");
    expect(actions.style.transform).toBe("translateY(-50%)");
    expect(copyButton.style.width).toBe("24px");
    expect(screen.queryByText("matrix shell connect")).toBeNull();
    expect(actions.style.maxHeight).toBe("");
    expect(within(actions).getByRole("button", { name: "Copy connect command for matrix-main" })).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "Close matrix-main" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy connect command for matrix-main" }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("matrix shell connect main");
    expect(copyButton.style.width).toBe("24px");
    expect(screen.getByTestId("terminal-session-copy-toast-main").textContent).toContain("Copied");
    expect(screen.getByTestId("terminal-session-copy-toast-main").className).toContain("sr-only");
    expect(within(actions).queryByText("matrix shell connect")).toBeNull();
  });

  it("copies with the synchronous selection fallback and still shows the Paper copy confirmation", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("clipboard denied");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.pointerMove(screen.getByTestId("terminal-session-card-main"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy connect command for matrix-main" }));
      await Promise.resolve();
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(screen.getByTestId("terminal-session-copy-toast-main").textContent).toContain("Copied");
  });

  it("falls back to the Clipboard API when legacy copy returns false", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    revealSessionActions("main");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy connect command for matrix-main" }));
      await Promise.resolve();
    });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText).toHaveBeenCalledWith("matrix shell connect main");
    expect(screen.getByTestId("terminal-session-copy-toast-main").textContent).toContain("Copied");
  });

  it("reorders active shell sessions with the Paper drag affordance", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions/order") && init?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", tabs: [] },
              { name: "review", status: "active", placement: "active", attachCommand: "mos shell attach review", tabs: [] },
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", tabs: [] },
              { name: "review", status: "active", placement: "active", attachCommand: "mos shell attach review", tabs: [] },
              { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const activeGroup = screen.getByTestId("terminal-session-group-active");
    const getOrder = () => Array.from(activeGroup.querySelectorAll("[data-session-name]"))
      .map((node) => node.getAttribute("data-session-name"));
    expect(getOrder()).toEqual(["main", "review", "docs"]);

    const dataTransfer = createDragDataTransfer();
    const mainHandle = screen.getByRole("button", { name: "Drag matrix-main session" });
    fireEvent.mouseEnter(screen.getByTestId("terminal-session-card-main"));
    fireEvent.dragStart(mainHandle, { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("terminal-session-card-docs"), { dataTransfer });

    expect(screen.getByTestId("terminal-session-drop-line-docs")).toBeTruthy();

    await act(async () => {
      fireEvent.drop(screen.getByTestId("terminal-session-card-docs"), { dataTransfer });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const orderCall = calls.find((call) => call.url.endsWith("/api/terminal/sessions/order") && call.init?.method === "PUT");
    expect(orderCall).toBeTruthy();
    expect(JSON.parse(String(orderCall?.init?.body))).toEqual({ order: ["review", "docs", "main"] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getOrder()).toEqual(["docs", "review", "main"]);
  });

  it("keeps an optimistic shell reorder visible while polling returns the old order", async () => {
    let shellList = [
      { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", tabs: [] },
      { name: "review", status: "active", placement: "active", attachCommand: "mos shell attach review", tabs: [] },
      { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", tabs: [] },
    ];
    let resolveOrder: ((value: Response) => void) | undefined;
    const orderPromise = new Promise<Response>((resolve) => {
      resolveOrder = resolve;
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions/order") && init?.method === "PUT") {
        return orderPromise;
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessions: shellList }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const activeGroup = screen.getByTestId("terminal-session-group-active");
    const getOrder = () => Array.from(activeGroup.querySelectorAll("[data-session-name]"))
      .map((node) => node.getAttribute("data-session-name"));
    expect(getOrder()).toEqual(["main", "review", "docs"]);

    const dataTransfer = createDragDataTransfer();
    fireEvent.mouseEnter(screen.getByTestId("terminal-session-card-main"));
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag matrix-main session" }), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("terminal-session-card-docs"), { dataTransfer });

    await act(async () => {
      fireEvent.drop(screen.getByTestId("terminal-session-card-docs"), { dataTransfer });
      await Promise.resolve();
    });
    expect(getOrder()).toEqual(["review", "docs", "main"]);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getOrder()).toEqual(["review", "docs", "main"]);

    shellList = [
      { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", tabs: [] },
      { name: "review", status: "active", placement: "active", attachCommand: "mos shell attach review", tabs: [] },
      { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", tabs: [] },
    ];
    await act(async () => {
      resolveOrder?.({
        ok: true,
        json: async () => ({ sessions: shellList }),
      } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getOrder()).toEqual(["docs", "review", "main"]);
  });

  it("renames sessions from the Paper pencil affordance", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
            ],
          }),
        } as Response);
      }
      if (url.endsWith("/api/terminal/sessions/main/rename") && init?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            session: {
              name: "review-main",
              status: "active",
              placement: "active",
              attachCommand: "mos shell attach review-main",
              attachedClients: 1,
              tabs: [{ idx: 0, name: "main", focused: true }],
            },
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = screen.getByRole("button", { name: "Open matrix-main" }).closest(".group");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);
    expect(row!.style.display).toBe("grid");
    expect(screen.getByRole("button", { name: "Open matrix-main" }).style.minWidth).toBe("0px");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename matrix-main" }));
      await Promise.resolve();
    });

    let input = screen.getByRole("textbox", { name: "Session name for matrix-main" });
    expect(screen.queryByRole("button", { name: "Rename matrix-main" })).toBeNull();
    await act(async () => {
      fireEvent.pointerDown(document.body);
      await Promise.resolve();
    });
    expect(screen.queryByRole("textbox", { name: "Session name for matrix-main" })).toBeNull();

    fireEvent.mouseEnter(row!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename matrix-main" }));
      await Promise.resolve();
    });
    input = screen.getByRole("textbox", { name: "Session name for matrix-main" });
    fireEvent.change(input, { target: { value: "review-main" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Open review-main" })).toBeTruthy();
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/main/rename"),
        init: expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ name: "review-main" }),
        }),
      }),
    ]));
  });

  it("asks for Paper confirmation before permanently deleting a session", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let deleted = false;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: deleted ? [] : [
              {
                name: "claude-review",
                status: "active",
                placement: "active",
                visualStatus: "finished",
                latestSeq: 2,
                lastSeenSeq: 1,
                unread: true,
                tabs: [{ idx: 0, name: "review", focused: true }],
              },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/claude-review") && init?.method === "DELETE") {
        deleted = true;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = screen.getByRole("button", { name: "Open claude-review" }).closest(".group");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close claude-review" }));
      await Promise.resolve();
    });

    const dialog = screen.getByRole("dialog", { name: "Close this session?" });
    expect(within(dialog).getByText("Closing ends the session and permanently deletes it and its transcript. You won't be able to reopen or recover it — this can't be undone.")).toBeTruthy();
    expect(within(dialog).getByText("claude-review")).toBeTruthy();
    expect(within(dialog).getByText("active · 1 unread")).toBeTruthy();
    expect(dialog.style.alignItems).toBe("center");
    expect(dialog.style.justifyContent).toBe("center");
    expect(dialog.style.background).toBe("rgba(3, 10, 3, 0.74)");
    expect(calls.filter((call) => call.init?.method === "DELETE")).toHaveLength(0);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "Close this session?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open claude-review" })).toBeTruthy();

    fireEvent.mouseEnter(row!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close claude-review" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Close this session?" })).getByRole("button", { name: "Delete" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls.filter((call) => call.init?.method === "DELETE")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Open claude-review" })).toBeNull();
  });

  it("uses the Paper mobile bottom sheet for session close confirmation", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", visualStatus: "idle", unread: false, tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = screen.getByRole("button", { name: "Open matrix-main" }).closest(".group");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close matrix-main" }));
      await Promise.resolve();
    });

    const dialog = screen.getByRole("dialog", { name: "Close this session?" });
    expect(dialog.style.alignItems).toBe("flex-end");
    const sheet = screen.getByTestId("terminal-close-confirmation-sheet");
    expect(sheet.style.borderTopLeftRadius).toBe("26px");
    expect(sheet.style.borderTopRightRadius).toBe("26px");
    expect(within(sheet).getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("persists Paper active and background placement toggles through the gateway", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 4, unread: true, visualStatus: "running", attachCommand: "mos shell attach main", tabs: [] },
              { name: "docs", status: "active", placement: "background", latestSeq: 11, lastSeenSeq: 5, unread: true, visualStatus: "idle", attachCommand: "mos shell attach docs", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/") && url.endsWith("/ui-state")) {
        return Promise.resolve({ ok: true, json: async () => ({ session: {} }) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("docs")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move matrix-main to background" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make docs active" }));
      await Promise.resolve();
    });

    const uiStateCalls = calls.filter((call) => call.url.includes("/ui-state"));
    expect(uiStateCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/main/ui-state"),
        init: expect.objectContaining({ method: "PATCH", body: JSON.stringify({ placement: "background" }) }),
      }),
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/docs/ui-state"),
        init: expect.objectContaining({ method: "PATCH", body: JSON.stringify({ placement: "active", lastSeenSeq: 11 }) }),
      }),
    ]));
    expect(uiStateCalls.filter((call) => call.url.includes("/api/terminal/sessions/docs/ui-state"))).toHaveLength(1);
  });

  it("opens a shell session when the drawer row surface is clicked", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 7, unread: false, visualStatus: "idle", attachCommand: "mos shell attach main", tabs: [] },
              { name: "docs", status: "active", placement: "background", latestSeq: 11, lastSeenSeq: 5, unread: true, visualStatus: "finished", attachCommand: "mos shell attach docs", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/") && url.endsWith("/ui-state")) {
        return Promise.resolve({ ok: true, json: async () => ({ session: {} }) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-row-main").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("terminal-session-row-main").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("data-selected")).toBe("false");

    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-session-row-docs"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-row-main").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("terminal-session-row-main").getAttribute("data-selected")).toBe("false");
    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("data-selected")).toBe("true");

    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/docs/ui-state"),
        init: expect.objectContaining({ method: "PATCH", body: JSON.stringify({ placement: "active", lastSeenSeq: 11 }) }),
      }),
    ]));
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree).toMatchObject({
      type: "pane",
      sessionId: "docs",
    });
  });

  it("renders Paper status dot colors and pulses only for running sessions", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "running", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 7, unread: false, visualStatus: "running", attachCommand: "mos shell attach running", tabs: [] },
              { name: "finished", status: "active", placement: "active", latestSeq: 9, lastSeenSeq: 4, unread: true, visualStatus: "finished", attachCommand: "mos shell attach finished", tabs: [] },
              { name: "idle", status: "active", placement: "active", latestSeq: 2, lastSeenSeq: 2, unread: false, visualStatus: "idle", attachCommand: "mos shell attach idle", tabs: [] },
              { name: "waiting", status: "active", placement: "background", latestSeq: 3, lastSeenSeq: 3, unread: false, visualStatus: "waiting", attachCommand: "mos shell attach waiting", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const running = screen.getByTestId("terminal-session-status-running");
    const finished = screen.getByTestId("terminal-session-status-finished");
    const idle = screen.getByTestId("terminal-session-status-idle");
    const waiting = screen.getByTestId("terminal-session-status-waiting");

    expect(screen.getByText("3 attached")).toBeTruthy();
    expect(screen.getByText("1 detached")).toBeTruthy();
    expect(running.style.background).toBe("rgb(95, 184, 95)");
    expect(running.style.boxShadow).toContain("rgba(95,184,95,0.24)");
    expect(running.classList.contains("terminal-session-status-dot--running")).toBe(true);
    expect(finished.style.background).toBe("rgb(46, 107, 58)");
    expect(finished.style.boxShadow).toBe("none");
    expect(finished.classList.contains("terminal-session-status-dot--running")).toBe(false);
    expect(idle.style.background).toBe("rgb(169, 170, 154)");
    expect(idle.style.boxShadow).toBe("none");
    expect(idle.classList.contains("terminal-session-status-dot--running")).toBe(false);
    expect(waiting.style.background).toBe("rgb(224, 161, 46)");
    expect(waiting.style.boxShadow).toContain("rgba(224,161,46,0.25)");
    expect(waiting.classList.contains("terminal-session-status-dot--running")).toBe(false);
  });

  it("keeps successful session updates when another optimistic UI patch rolls back", async () => {
    let resolveMarkSeen: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 4, unread: true, visualStatus: "running", attachCommand: "mos shell attach main", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/main/ui-state")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { placement?: string; lastSeenSeq?: number };
        if (body.lastSeenSeq === 7 && body.placement === undefined) {
          return new Promise<Response>((resolve) => {
            resolveMarkSeen = resolve;
          });
        }
        if (body.placement === "background") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              session: { name: "main", status: "active", placement: "background", latestSeq: 7, lastSeenSeq: 4, unread: true, visualStatus: "running", attachCommand: "mos shell attach main", tabs: [] },
            }),
          } as Response);
        }
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move matrix-main to background" }));
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Make matrix-main active" })).toBeTruthy();
    expect(resolveMarkSeen).toBeDefined();

    await act(async () => {
      resolveMarkSeen?.({ ok: false, json: async () => ({}) } as Response);
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Make matrix-main active" })).toBeTruthy();
  });

  it("focuses active shell rows without creating duplicate attached tabs or layout save noise", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockClear();
    const paneRenderCount = paneGridSpy.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.calls).toHaveLength(paneRenderCount);
    const layoutSaveCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));
    expect(layoutSaveCalls).toHaveLength(0);
  });

  it("renders a mobile sessions surface with compact foreground and background toggles", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("matrixos")).toBeTruthy();
    expect(screen.getByPlaceholderText("Find a session...")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move matrix-main to background" })).toBeTruthy();
    expect(screen.queryByText("Zellij")).toBeNull();
  });

  it("opens mobile terminal detail with back navigation and command composer", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
      await Promise.resolve();
    });

    expect(screen.queryByPlaceholderText("Find a session...")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to sessions" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Command composer" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
      await Promise.resolve();
    });

    expect(screen.getByPlaceholderText("Find a session...")).toBeTruthy();
  });

  it("opens the Paper new-session menu before creating a new session", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      await openNewSessionMenu();
    });

    const menu = screen.getByRole("menu", { name: "New session menu" });
    expect(within(menu).getByText("NEW TAB")).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Shell.*⌘T/i })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Claude Code.*⌘⇧C/i })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Codex.*⌘⇧X/i })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") &&
      init?.method === "POST"
    ))).toBe(false);
  });

  it("opens Matrix-named shell sessions from the new-session menu", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await chooseNewSessionMenuItem(/Shell/);
    });

    const createCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([input, init]: [RequestInfo | URL, RequestInit | undefined]) => (
        String(input).endsWith("/api/terminal/sessions") &&
        init?.method === "POST" &&
        typeof init.body === "string"
      ))
      .map(([, init]: [RequestInfo | URL, RequestInit]) => JSON.parse(String(init.body)) as { name: string });

    expect(createCalls.some((body) => /^matrix-/.test(body.name))).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^matrix-/),
      },
    });
  });

  it("shows a pending shell row and disables creation controls while a new session is starting", async () => {
    let resolveCreate: (response: Response) => void = () => {};
    let created = false;
    let createdName = "matrix-pending";
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method === "POST") {
        if (typeof init.body === "string") {
          createdName = (JSON.parse(init.body) as { name?: string }).name ?? createdName;
        }
        if (createdName === "main") {
          return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
        }
        return new Promise<Response>((resolve) => {
          resolveCreate = (response) => {
            created = true;
            resolve(response);
          };
        });
      }
      if (url.endsWith("/api/terminal/sessions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", tabs: [] },
              ...(created ? [{ name: createdName, status: "active", placement: "active", tabs: [] }] : []),
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await openNewSessionMenu();
    const newSessionButton = screen.getByRole("button", { name: "New session" });
    const menu = screen.getByRole("menu", { name: "New session menu" });

    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Shell.*⌘T/i }));
      await Promise.resolve();
    });

    expect(newSessionButton).toHaveProperty("disabled", true);
    expect(screen.getByTestId("terminal-session-pending-row").textContent).toContain("Creating session");

    await act(async () => {
      resolveCreate({ ok: true, json: async () => ({ name: "matrix-pending" }) } as Response);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("terminal-session-pending-row")).toBeNull();
    expect(screen.getByTestId(`terminal-session-card-${createdName}`)).toBeTruthy();
  });

  it("opens the left terminal panel on Shells first", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByLabelText("Search sessions")).toBeTruthy();
  });

  it("keeps shell placement badges inside their row height", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const activeToggle = screen.getByRole("button", { name: "Move matrix-main to background" });
    expect(activeToggle.style.height).toBe("20px");
    expect(activeToggle.style.boxSizing).toBe("border-box");
    expect(activeToggle.style.overflow).toBe("hidden");
    expect(activeToggle.style.alignSelf).toBe("center");
  });

  it("lets desktop users resize the terminal sessions drawer", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sidebarShell = screen.getByTestId("terminal-sidebar-shell");
    expect(sidebarShell.style.width).toBe("392px");

    const resizeHandle = screen.getByRole("button", { name: "Resize sessions drawer" });
    const setPointerCapture = vi.fn();
    Object.defineProperty(resizeHandle, "setPointerCapture", { configurable: true, value: setPointerCapture });
    await act(async () => {
      fireEvent.pointerDown(resizeHandle, { clientX: 392, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 456 });
      fireEvent.pointerUp(window);
      await Promise.resolve();
    });

    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(sidebarShell.style.width).toBe("456px");

    await act(async () => {
      fireEvent.keyDown(resizeHandle, { key: "ArrowLeft" });
      await Promise.resolve();
    });

    expect(sidebarShell.style.width).toBe("440px");
  });

  it("stops terminal drawer resizing when the drag is canceled", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sidebarShell = screen.getByTestId("terminal-sidebar-shell");
    const resizeHandle = screen.getByRole("button", { name: "Resize sessions drawer" });
    await act(async () => {
      fireEvent.pointerDown(resizeHandle, { clientX: 392, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 456 });
      fireEvent.pointerCancel(window);
      fireEvent.pointerMove(window, { clientX: 520 });
      await Promise.resolve();
    });

    expect(sidebarShell.style.width).toBe("456px");
  });

  it("does not treat terminal chrome control double-clicks as title-bar zooms", async () => {
    const handleTitleDoubleClick = vi.fn();
    render(<TerminalApp windowControls={{ dragHandleProps: { onDoubleClick: handleTitleDoubleClick } }} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.doubleClick(screen.getByRole("button", { name: "Toggle Terminal fullscreen" }));

    expect(handleTitleDoubleClick).not.toHaveBeenCalled();
  });

  it("highlights the shell attached to the active restored pane on first render", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [
              {
                id: "tab-docs",
                label: "Docs",
                paneTree: { type: "pane", id: "pane-docs", cwd: "projects", sessionId: "docs" },
              },
            ],
            activeTabId: "tab-docs",
            sidebarOpen: true,
          }),
        } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", tabs: [] },
              { name: "docs", status: "active", placement: "active", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("terminal-session-row-main").getAttribute("data-selected")).toBe("false");
  });

  it("attaches and highlights the first ordered shell when no saved layout exists", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "bench", status: "active", placement: "active", tabs: [] },
              { name: "main", status: "active", placement: "active", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: "bench",
      },
    });
    expect(screen.getByTestId("terminal-session-row-bench").getAttribute("data-selected")).toBe("true");
  });

  it("renders the Paper collapsed sessions rail in layout flow when hidden", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-drawer-collapse-icon").querySelector('path[d="m11 17-5-5 5-5"]')).toBeTruthy();
    expect(screen.getByTestId("terminal-sidebar-shell").style.transition).toContain("transform");

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));

    const sidebarShell = screen.getByTestId("terminal-sidebar-shell");
    expect(sidebarShell.style.transition).toContain("transform");
    expect(sidebarShell.style.opacity).toBe("1");
    const rail = screen.getByTestId("terminal-collapsed-rail");
    expect(rail.style.width).toBe("76px");
    expect(rail.className).not.toContain("absolute");
    expect(screen.getByRole("button", { name: "Expand sessions drawer" })).toBeTruthy();
    expect(screen.getByTestId("terminal-drawer-expand-icon").querySelector('path[d="m6 17 5-5-5-5"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
    const matrixRailButton = screen.getByRole("button", { name: "Open matrix-main" });
    expect(matrixRailButton.textContent).toBe("mma");
    expect(matrixRailButton.getAttribute("aria-current")).toBe("true");
    expect(matrixRailButton.getAttribute("data-selected")).toBe("true");
  });

  it("uses Paper collapsed rail abbreviations and fixed control sizing", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", visualStatus: "running", tabs: [] },
              { name: "claude-review", status: "active", placement: "active", visualStatus: "finished", tabs: [] },
              { name: "codex-backend", status: "active", placement: "active", visualStatus: "waiting", tabs: [] },
              { name: "deploy-logs", status: "active", placement: "background", visualStatus: "running", tabs: [] },
              { name: "hotfix-auth", status: "active", placement: "background", visualStatus: "idle", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));

    const fixedControls = [
      screen.getByTestId("terminal-collapsed-brand"),
      screen.getByRole("button", { name: "Expand sessions drawer" }),
      screen.getByRole("button", { name: "New session" }),
      screen.getByRole("button", { name: "Open matrix-main" }),
      screen.getByRole("button", { name: "Open claude-review" }),
    ];
    for (const control of fixedControls) {
      expect(control.style.width).toBe("40px");
      expect(control.style.height).toBe("40px");
      expect(control.style.flexShrink).toBe("0");
    }
    const matrixRailButton = screen.getByRole("button", { name: "Open matrix-main" });
    const matrixRailDot = screen.getByTestId("terminal-session-status-main");
    expect(matrixRailButton.style.overflow).toBe("visible");
    expect(matrixRailDot.style.top).toBe("-3px");
    expect(matrixRailDot.style.right).toBe("-3px");
    expect(matrixRailDot.style.borderTopWidth).toBe("2px");
    expect(matrixRailDot.style.borderTopColor).toBe("rgb(233, 233, 216)");
    expect(matrixRailDot.style.zIndex).toBe("1");
    const newSessionIcon = screen.getByTestId("terminal-collapsed-new-session-icon");
    expect(newSessionIcon.getAttribute("width")).toBe("18");
    expect(newSessionIcon.getAttribute("height")).toBe("18");

    expect(screen.getByRole("button", { name: "Open matrix-main" }).textContent).toBe("mma");
    expect(screen.getByRole("button", { name: "Open claude-review" }).textContent).toBe("cre");
    expect(screen.getByRole("button", { name: "Open codex-backend" }).textContent).toBe("cba");
    expect(screen.getByRole("button", { name: "Open deploy-logs" }).textContent).toBe("dlo");
    expect(screen.getByRole("button", { name: "Open hotfix-auth" }).textContent).toBe("hau");
  });

  it("keeps collapsed rail sessions visible after hiding a filtered drawer", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search sessions"), { target: { value: "no-matches" } });
    });

    expect(screen.getByText("No sessions match")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));
    });

    expect(screen.getByTestId("terminal-collapsed-rail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
  });

  it("opens Matrix-named shell sessions from Ctrl+Shift+T", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("application", { name: "Terminal" }), {
        key: "T",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^matrix-/),
      },
    });
  });

  it("copies a local CLI attach command when clicking a shell session name", async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
        json: async () => ({ sessions: [{ name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [] }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    revealSessionActions("main");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy connect command for matrix-main" }));
      await Promise.resolve();
    });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("does not persist the mobile-forced sidebar state into shared terminal layout", async () => {
    render(<TerminalApp mobile initialSessionId="main" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    const layoutSave = vi.mocked(global.fetch).mock.calls.find(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));
    expect(layoutSave).toBeUndefined();
  });

  it("starts normal terminal tabs on the canonical main shell session", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree).toMatchObject({
      type: "pane",
      sessionId: "main",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "main", cwd: "projects" }),
      }),
    );
  });

  it("replaces saved legacy pty layouts with the canonical main shell session", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [{
              id: "legacy-tab",
              label: "projects",
              paneTree: {
                type: "pane",
                id: "legacy-pane",
                cwd: "projects",
                sessionId: "550e8400-e29b-41d4-a716-446655440000",
              },
            }],
            activeTabId: "legacy-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree.sessionId).toBe("main");
  });

  it("replaces mixed canonical and legacy pty layouts with the canonical main shell session", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [
              {
                id: "main-tab",
                label: "main",
                paneTree: {
                  type: "pane",
                  id: "main-pane",
                  cwd: "projects",
                  sessionId: "main",
                },
              },
              {
                id: "legacy-tab",
                label: "Legacy Zellij",
                paneTree: {
                  type: "pane",
                  id: "legacy-pane",
                  cwd: "projects",
                  sessionId: "550e8400-e29b-41d4-a716-446655440000",
                },
              },
            ],
            activeTabId: "legacy-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Legacy Zellij")).toBeNull();
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree.sessionId).toBe("main");
  });

  it("recreates saved canonical shell sessions before restoring a layout", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [{
              id: "bench-tab",
              label: "bench",
              paneTree: {
                type: "pane",
                id: "bench-pane",
                cwd: "projects",
                sessionId: "bench",
              },
            }],
            activeTabId: "bench-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "bench", cwd: "projects" }),
      }),
    );
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree.sessionId).toBe("bench");
  });

  it("does not replace a legacy layout after unmount while ensuring the canonical session", async () => {
    let resolveSessions: ((value: { ok: boolean; json: () => Promise<{ sessions: Array<{ name: string }> }> }) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [{
              id: "legacy-tab",
              label: "projects",
              paneTree: {
                type: "pane",
                id: "legacy-pane",
                cwd: "projects",
                sessionId: "550e8400-e29b-41d4-a716-446655440000",
              },
            }],
            activeTabId: "legacy-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return new Promise((resolve) => {
          resolveSessions = resolve;
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    const { unmount } = render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsBeforeUnmount = paneGridSpy.mock.calls.length;

    unmount();
    await act(async () => {
      resolveSessions?.({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it("persists attached session ids in the saved layout", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy).toHaveBeenCalled();

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; id: string };
      onSessionAttached: (paneId: string, sessionId: string) => void;
    };

    expect(props.paneTree.type).toBe("pane");

    act(() => {
      props.onSessionAttached(props.paneTree.id, "session-123");
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const layoutPutCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));

    expect(layoutPutCalls.length).toBeGreaterThan(0);
    const latestBody = layoutPutCalls.at(-1)?.[1]?.body;
    expect(typeof latestBody).toBe("string");
    expect(JSON.parse(latestBody as string)).toMatchObject({
      tabs: [
        {
          paneTree: {
            sessionId: "session-123",
          },
        },
      ],
    });
  });

  it("flushes attached session ids on pagehide before the debounce fires", async () => {
    render(<TerminalApp />);

    // Flush microtasks so async initLayout completes and setInitialized(true) propagates
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; id: string };
      onSessionAttached: (paneId: string, sessionId: string) => void;
    };

    act(() => {
      props.onSessionAttached(props.paneTree.id, "session-refresh");
    });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const layoutPutCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));

    expect(layoutPutCalls.length).toBeGreaterThan(0);
    const latestBody = layoutPutCalls.at(-1)?.[1]?.body;
    expect(typeof latestBody).toBe("string");
    expect(JSON.parse(latestBody as string)).toMatchObject({
      tabs: [
        {
          paneTree: {
            sessionId: "session-refresh",
          },
        },
      ],
    });
  });

  it("creates toolbar shell launches as Matrix-named canonical shell sessions", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      await chooseNewSessionMenuItem(/Shell/);
    });

    const createCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input).includes("/api/terminal/sessions") &&
      init?.method === "POST" &&
      typeof init.body === "string" &&
      JSON.parse(init.body).name.startsWith("matrix-")
    ));
    expect(createCall).toBeTruthy();
    const body = JSON.parse(createCall?.[1]?.body as string) as { name: string; cwd: string };
    expect(body).toMatchObject({ cwd: "projects" });
    expect(body.name).toMatch(/^matrix-[a-z0-9]+$/);

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string; startupCommand?: string };
    };
    expect(props.paneTree.sessionId).toBe(body.name);
    expect(props.paneTree.startupCommand).toBeUndefined();
  });

  it("cleans up a just-created Matrix shell when unmounted before the tab is attached", async () => {
    let resolveCreate: ((value: { ok: boolean; status: number; json: () => Promise<{ name: string }> }) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method !== "POST" && init?.method !== "DELETE") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      if (url.includes("/api/terminal/sessions/") && init?.method === "DELETE") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    const { unmount } = render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      await chooseNewSessionMenuItem(/Shell/);
    });

    const createCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input).includes("/api/terminal/sessions") &&
      init?.method === "POST"
    ));
    expect(createCall).toBeTruthy();
    const name = JSON.parse(createCall?.[1]?.body as string).name as string;

    unmount();
    await act(async () => {
      resolveCreate?.({ ok: true, status: 200, json: async () => ({ name }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/terminal/sessions/${name}?force=1`),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("manages canonical Matrix shells from a dedicated sidebar surface", async () => {
    let mainDeleted = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions/main") && init?.method === "DELETE") {
        mainDeleted = true;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ name: "matrix-new", created: true }) });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              ...(mainDeleted ? [] : [{
                name: "main",
                status: "active",
                attachedClients: 1,
                tabs: [{ idx: 0, name: "dev", focused: true }],
              }]),
              {
              name: "bench",
              status: "degraded",
              attachedClients: 0,
              tabs: [{ idx: 0, name: "latency", focused: true }, { idx: 3, name: "load" }],
            }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Search sessions")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
    expect(screen.getByText("bench")).toBeTruthy();
    const mainCard = screen.getByTestId("terminal-session-card-main");
    const mainPlacementToggle = screen.getByRole("button", { name: "Move matrix-main to background" });
    expect(mainPlacementToggle.parentElement).toBe(mainCard);
    expect(mainPlacementToggle.style.position).toBe("relative");
    expect(mainPlacementToggle.style.zIndex).toBe("1");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open bench/i }));
    });
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: { sessionId: "bench" },
    });

    await act(async () => {
      await openNewSessionMenu();
      const menu = screen.getByRole("menu", { name: "New session menu" });
      const shellItem = within(menu).getByRole("menuitem", { name: /Shell/ });
      fireEvent.click(shellItem);
      fireEvent.click(shellItem);
      await Promise.resolve();
      await Promise.resolve();
    });
    const createCalls = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions") && init?.method === "POST"
    ));
    expect(createCalls).toHaveLength(1);

    revealSessionActions("main");

    await act(async () => {
      const deleteButton = screen.getByRole("button", { name: /close matrix-main/i });
      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);
      await Promise.resolve();
    });
    expect(vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions/main?force=1") && init?.method === "DELETE"
    ))).toHaveLength(0);
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Close this session?" })).getByRole("button", { name: "Delete" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const deleteCalls = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions/main?force=1") && init?.method === "DELETE"
    ));
    expect(deleteCalls).toHaveLength(1);
    expect(screen.queryByText("matrix-main")).toBeNull();
  });

  it("keeps the Shells sidebar synchronized after manual refresh", async () => {
    let revealBench = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: revealBench
              ? [{ name: "main", status: "active" }, { name: "bench", status: "active" }]
              : [{ name: "main", status: "active" }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();
    expect(screen.queryByText("bench")).toBeNull();

    await act(async () => {
      revealBench = true;
      fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("bench")).toBeTruthy();
  });

  it("keeps the last known Shells list visible during transient refresh failures", async () => {
    let shellListMode: "initial" | "fail" | "recover" = "initial";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        if (shellListMode === "fail") {
          shellListMode = "recover";
          return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: shellListMode === "recover"
              ? [{ name: "main", status: "active" }, { name: "bench", status: "active" }]
              : [{ name: "main", status: "active" }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();
    shellListMode = "fail";

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();
    expect(screen.getByText("Failed to load shells")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("bench")).toBeTruthy();
    expect(screen.queryByText("Failed to load shells")).toBeNull();
  });

  it("refreshes the Shells sidebar while open so exited zellij sessions disappear", async () => {
    let shellList = [{ name: "main", status: "active" }];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessions: shellList }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText("main").length).toBeGreaterThan(0);
    const shellListCallsBeforeWait = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") && init?.method !== "POST"
    )).length;

    await act(async () => {
      shellList = [];
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const shellListCallsAfterWait = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") && init?.method !== "POST"
    )).length;
    expect(shellListCallsAfterWait).toBeGreaterThan(shellListCallsBeforeWait);
    expect(screen.queryByRole("button", { name: "Copy connect command for matrix-main" })).toBeNull();
  });

  it("does not clobber a concurrent Shells refresh when delete rollback runs", async () => {
    let shellList = [{ name: "main", status: "active" }];
    let resolveDelete: ((value: { ok: boolean; status: number; json: () => Promise<object> }) => void) | undefined;
    const deletePromise = new Promise<{ ok: boolean; status: number; json: () => Promise<object> }>((resolve) => {
      resolveDelete = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions/main?force=1") && init?.method === "DELETE") {
        return deletePromise;
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessions: shellList }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();

    revealSessionActions("main");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /close matrix-main/i }));
      await Promise.resolve();
    });
    expect(screen.getByRole("dialog", { name: "Close this session?" })).toBeTruthy();
    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Close this session?" })).getByRole("button", { name: "Delete" }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Copy connect command for matrix-main" })).toBeNull();

    await act(async () => {
      shellList = [{ name: "bench", status: "active" }];
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("bench")).toBeTruthy();

    await act(async () => {
      resolveDelete?.({ ok: false, status: 503, json: async () => ({ ok: false }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("bench")).toBeTruthy();
    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();
    expect(screen.getByText("Failed to remove shell")).toBeTruthy();
  });

  it("surfaces shell creation failures in the Shells sidebar", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false }) });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main", status: "active" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await chooseNewSessionMenuItem(/Shell/);
    });

    expect(screen.getByText("Failed to create shell")).toBeTruthy();
  });

  it("renders agent install state in the new-session menu without ready badges", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            agents: [
              { id: "claude", installed: true, authState: "ok" },
              { id: "codex", installed: true, authState: "ok" },
              { id: "opencode", installed: false, authState: "unknown", errorCode: "agent_missing" },
              { id: "pi", installed: false, authState: "unknown", errorCode: "agent_missing" },
            ],
          }),
        });
      }
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await openNewSessionMenu();
    });

    const menu = screen.getByRole("menu", { name: "New session menu" });
    expect(within(menu).getByRole("menuitem", { name: /Shell/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Claude Code/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Codex/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /OpenCode.*Install/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Pi.*Install/ })).toBeTruthy();
    expect(within(menu).queryByText("Ready")).toBeNull();
    expect(within(menu).getAllByText("Install")).toHaveLength(2);
    expect(within(menu).getByTestId("terminal-agent-logo-claude")).toBeTruthy();
    expect(within(menu).getByTestId("terminal-agent-logo-codex")).toBeTruthy();
    expect(within(menu).getByTestId("terminal-agent-logo-opencode")).toBeTruthy();
    expect(within(menu).getByTestId("terminal-agent-logo-pi")).toBeTruthy();
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-claude"), "/agent-logos/claude-code.png");
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-codex"), "/agent-logos/codex.png");
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-opencode"), "/agent-logos/opencode-white.png");
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-pi"), "/agent-logos/pi-coding-agent.png");
  });

  it("starts installed agents directly from the new-session menu", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            agents: [
              { id: "claude", installed: true, authState: "ok" },
              { id: "codex", installed: true, authState: "ok" },
              { id: "opencode", installed: true, authState: "ok" },
              { id: "pi", installed: true, authState: "ok" },
            ],
          }),
        });
      }
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await chooseNewSessionMenuItem(/Claude Code/);
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        claudeMode: true,
        startupCommand: undefined,
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItem(/Codex/);
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        claudeMode: false,
        startupCommand: "codex",
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/^OpenCode$/);
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        claudeMode: false,
        startupCommand: "opencode",
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/^Pi$/);
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        claudeMode: false,
        startupCommand: "pi",
      },
    });
  });

  it("opens a new shell tab that runs the installer when an agent is missing", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            agents: [
              { id: "claude", installed: false, authState: "unknown", errorCode: "agent_missing" },
              { id: "codex", installed: false, authState: "unknown", errorCode: "agent_missing" },
              { id: "opencode", installed: false, authState: "unknown", errorCode: "agent_missing" },
              { id: "pi", installed: false, authState: "unknown", errorCode: "agent_missing" },
            ],
          }),
        });
      }
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/Claude Code.*Install/);
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        claudeMode: false,
        startupCommand: expectedAgentInstallCommand("@anthropic-ai/claude-code@latest"),
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/Codex.*Install/);
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        claudeMode: false,
        startupCommand: expectedAgentInstallCommand("@openai/codex@latest"),
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/OpenCode.*Install/);
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        claudeMode: false,
        startupCommand: expectedAgentInstallCommand("opencode-ai@latest"),
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/Pi.*Install/);
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        claudeMode: false,
        startupCommand: expectedAgentInstallCommand("@earendil-works/pi-coding-agent@latest", ["--ignore-scripts"]),
      },
    });
  });
});
