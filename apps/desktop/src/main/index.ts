import { app, BrowserView, BrowserWindow, ipcMain, shell, type Rectangle } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopLaunchPlan,
  createDesktopRuntimePolicy,
  loadDesktopWindowState,
  parseMatrixDesktopConfig,
  saveDesktopWindowState,
  type DesktopWindowState,
} from "./config.js";
import { createWindowOpenHandler, isAllowedShellNavigation, openAllowedExternalUrl } from "./security.js";

const WORKBENCH_KINDS = new Set(["shell", "app", "terminal", "workspace", "file-browser", "chat"] as const);

export interface DesktopWorkbenchTabInput {
  title: string;
  url: string;
  kind?: "shell" | "app" | "terminal" | "workspace" | "file-browser" | "chat";
}

export interface DesktopWorkbenchTab {
  id: string;
  title: string;
  url: string;
  kind: NonNullable<DesktopWorkbenchTabInput["kind"]>;
  loading: boolean;
}

export interface DesktopWorkbenchApp {
  id: string;
  name: string;
  url: string;
  kind: DesktopWorkbenchTab["kind"];
  category: string;
  defaultApp: boolean;
}

export interface DesktopWorkbenchSnapshot {
  activeTabId: string | null;
  chromeHeight: number;
  tabs: DesktopWorkbenchTab[];
}

interface DesktopWorkbenchTabRecord extends DesktopWorkbenchTab {
  view: BrowserView;
  fallbackUrl?: string;
  fallbackAttempted: boolean;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const NORMAL_CHROME_HEIGHT = 108;
const MIN_CHROME_HEIGHT = 88;
const MAX_CHROME_HEIGHT = 420;
const TAB_VIEW_MIN_HEIGHT = 120;
const GATEWAY_FETCH_TIMEOUT_MS = 10_000;
const MAX_WORKBENCH_TABS = 32;
const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BUILTIN_APPS: DesktopWorkbenchApp[] = [
  { id: "shell", name: "Matrix Shell", url: "/", kind: "shell", category: "system", defaultApp: true },
  { id: "workspace", name: "Workspace", url: "/desktop/workspace", kind: "workspace", category: "developer", defaultApp: true },
  { id: "terminal", name: "Terminal", url: "/desktop/terminal", kind: "terminal", category: "developer", defaultApp: true },
  { id: "files", name: "Files", url: "/desktop/files", kind: "file-browser", category: "system", defaultApp: true },
  { id: "chat", name: "Chat", url: "/desktop/chat", kind: "chat", category: "ai", defaultApp: true },
  { id: "symphony", name: "Symphony", url: "/desktop/apps/symphony", kind: "app", category: "developer", defaultApp: true },
  { id: "task-manager", name: "Task Manager", url: "/desktop/apps/task-manager", kind: "app", category: "productivity", defaultApp: true },
];

app.enableSandbox();

const desktopConfig = parseMatrixDesktopConfig();
const desktopRuntimePolicy = createDesktopRuntimePolicy(desktopConfig);
const windowStatePath = () => join(app.getPath("userData"), "window-state.json");
let workbench: DesktopWorkbench | null = null;
const EMPTY_WORKBENCH_SNAPSHOT: DesktopWorkbenchSnapshot = {
  activeTabId: null,
  chromeHeight: NORMAL_CHROME_HEIGHT,
  tabs: [],
};

function absoluteShellUrl(path: string): string {
  return new URL(path, desktopConfig.shellUrl).toString();
}

function normalizeChromeHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return NORMAL_CHROME_HEIGHT;
  return Math.min(MAX_CHROME_HEIGHT, Math.max(MIN_CHROME_HEIGHT, value));
}

function rendererEntryUrl(): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) return devUrl;
  return `file://${join(__dirname, "../renderer/index.html")}`;
}

function sanitizeTabInput(input: unknown): DesktopWorkbenchTabInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.url !== "string" || record.url.length < 1 || record.url.length > 2048) return null;
  const rawTitle = typeof record.title === "string" ? record.title.trim() : "";
  const title = rawTitle.length > 0 ? rawTitle.slice(0, 80) : "Matrix";
  const kind = WORKBENCH_KINDS.has(record.kind as DesktopWorkbenchTab["kind"])
    ? record.kind as DesktopWorkbenchTab["kind"]
    : "app";
  return { title, url: record.url, kind };
}

function currentWorkbenchSnapshot(): DesktopWorkbenchSnapshot {
  return workbench?.snapshot() ?? EMPTY_WORKBENCH_SNAPSHOT;
}

function createView(): BrowserView {
  return new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, "../preload/index.js"),
    },
  });
}

class DesktopWorkbench {
  private readonly win: BrowserWindow;
  private readonly allowedShellOrigins: ReadonlySet<string>;
  private readonly tabs = new Map<string, DesktopWorkbenchTabRecord>();
  private activeTabId: string | null = null;
  private chromeHeight = NORMAL_CHROME_HEIGHT;

  constructor(win: BrowserWindow, allowedShellOrigins: ReadonlySet<string>) {
    this.win = win;
    this.allowedShellOrigins = allowedShellOrigins;
    this.win.on("resize", () => this.layoutActiveView());
  }

  snapshot(): DesktopWorkbenchSnapshot {
    return {
      activeTabId: this.activeTabId,
      chromeHeight: this.chromeHeight,
      tabs: [...this.tabs.values()].map(({ view: _view, fallbackUrl: _fallbackUrl, fallbackAttempted: _fallbackAttempted, ...tab }) => tab),
    };
  }

  emitSnapshot(): DesktopWorkbenchSnapshot {
    const snapshot = this.snapshot();
    this.win.webContents.send("matrix-desktop:workbench-snapshot", snapshot);
    return snapshot;
  }

  setChromeHeight(height: number): DesktopWorkbenchSnapshot {
    this.chromeHeight = normalizeChromeHeight(height);
    this.layoutActiveView();
    return this.emitSnapshot();
  }

  openTab(input: DesktopWorkbenchTabInput): DesktopWorkbenchSnapshot {
    const targetUrl = this.resolveWorkbenchUrl(input.url);
    if (!targetUrl) return this.snapshot();
    const existing = [...this.tabs.values()].find((tab) => tab.url === targetUrl && tab.kind !== "terminal");
    if (existing) {
      return this.focusTab(existing.id);
    }

    this.evictOverflowTab();

    const id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const view = createView();
    const tab: DesktopWorkbenchTabRecord = {
      id,
      title: input.title,
      url: targetUrl,
      kind: input.kind ?? "app",
      loading: true,
      view,
      fallbackUrl: this.fallbackUrlFor(input, targetUrl),
      fallbackAttempted: false,
    };
    this.tabs.set(id, tab);
    this.configureView(tab);
    this.focusTab(id);
    void view.webContents.loadURL(targetUrl).catch((err: unknown) => {
      console.warn("[desktop] Failed to load workbench tab", err instanceof Error ? err.name : "UnknownError");
      tab.loading = false;
      this.emitSnapshot();
    });
    return this.emitSnapshot();
  }

  focusTab(id: string): DesktopWorkbenchSnapshot {
    const tab = this.tabs.get(id);
    if (!tab) return this.snapshot();
    if (this.activeTabId && this.activeTabId !== id) {
      const current = this.tabs.get(this.activeTabId);
      if (current) this.win.removeBrowserView(current.view);
    }
    if (!this.win.getBrowserViews().includes(tab.view)) {
      this.win.addBrowserView(tab.view);
    }
    this.activeTabId = id;
    this.win.setTopBrowserView(tab.view);
    this.layoutActiveView();
    tab.view.webContents.focus();
    return this.emitSnapshot();
  }

  closeTab(id: string): DesktopWorkbenchSnapshot {
    const tab = this.tabs.get(id);
    if (!tab) return this.snapshot();
    const wasActive = this.activeTabId === id;
    this.destroyTab(tab);
    if (wasActive) {
      const next = [...this.tabs.keys()].at(-1) ?? null;
      if (next) return this.focusTab(next);
    }
    return this.emitSnapshot();
  }

  private evictOverflowTab(): void {
    if (this.tabs.size < MAX_WORKBENCH_TABS) return;
    const candidateId = [...this.tabs.keys()].find((id) => id !== this.activeTabId) ?? this.activeTabId;
    const candidate = candidateId ? this.tabs.get(candidateId) : undefined;
    if (candidate) {
      this.destroyTab(candidate);
    }
  }

  private destroyTab(tab: DesktopWorkbenchTabRecord): void {
    if (this.win.getBrowserViews().includes(tab.view)) {
      this.win.removeBrowserView(tab.view);
    }
    tab.view.webContents.close({ waitForBeforeUnload: false });
    this.tabs.delete(tab.id);
    if (this.activeTabId === tab.id) {
      this.activeTabId = null;
    }
  }

  private configureView(tab: DesktopWorkbenchTabRecord): void {
    const openWindow = createWindowOpenHandler({
      openExternal: (url) => shell.openExternal(url),
      openAuthUrl: (url) => tab.view.webContents.loadURL(url),
    });
    tab.view.webContents.setWindowOpenHandler(({ url }) => {
      if (this.isWorkbenchUrl(url)) {
        this.openTab({ title: new URL(url).hostname, url, kind: "app" });
      } else {
        void openWindow({ url });
      }
      return { action: "deny" };
    });
    tab.view.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedShellNavigation(url, this.allowedShellOrigins)) {
        event.preventDefault();
        void openWindow({ url });
      }
    });
    tab.view.webContents.on("did-start-loading", () => {
      tab.loading = true;
      this.emitSnapshot();
    });
    tab.view.webContents.on("did-stop-loading", () => {
      tab.loading = false;
      this.emitSnapshot();
    });
    tab.view.webContents.on("did-finish-load", () => {
      void this.recoverStandaloneRoute404(tab);
    });
    tab.view.webContents.on("page-title-updated", (_event, title) => {
      if (title && title !== tab.title) {
        tab.title = title;
        this.emitSnapshot();
      }
    });
  }

  private contentBounds(): Rectangle {
    const [width, height] = this.win.getContentSize();
    const y = Math.min(this.chromeHeight, Math.max(0, height - TAB_VIEW_MIN_HEIGHT));
    return {
      x: 0,
      y,
      width,
      height: Math.max(TAB_VIEW_MIN_HEIGHT, height - y),
    };
  }

  private layoutActiveView(): void {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;
    tab.view.setBounds(this.contentBounds());
    tab.view.setAutoResize({ width: true, height: true });
  }

  private resolveWorkbenchUrl(rawUrl: string): string | null {
    try {
      const targetUrl = absoluteShellUrl(rawUrl);
      return this.isWorkbenchUrl(targetUrl) ? targetUrl : null;
    } catch (err: unknown) {
      if (!(err instanceof TypeError)) {
        console.warn("[desktop] Failed to resolve workbench URL", err instanceof Error ? err.name : "UnknownError");
      }
      return null;
    }
  }

  private isWorkbenchUrl(rawUrl: string): boolean {
    try {
      const parsed = new URL(rawUrl);
      return this.allowedShellOrigins.has(parsed.origin);
    } catch (err: unknown) {
      if (!(err instanceof TypeError)) {
        console.warn("[desktop] Failed to parse workbench URL", err instanceof Error ? err.name : "UnknownError");
      }
      return false;
    }
  }

  private fallbackUrlFor(input: DesktopWorkbenchTabInput, targetUrl: string): string | undefined {
    const parsed = new URL(targetUrl);
    if (!parsed.pathname.startsWith("/desktop/")) return undefined;
    const fallback = new URL("/", desktopConfig.shellUrl);
    fallback.searchParams.set("matrixDesktopApp", input.kind ?? "app");
    if (input.kind === "terminal") {
      fallback.searchParams.set("session", parsed.searchParams.get("session") ?? Date.now().toString(36));
    } else if (input.kind === "workspace") {
      fallback.searchParams.set("path", "__workspace__");
    } else if (input.kind === "file-browser") {
      fallback.searchParams.set("path", "__file-browser__");
    } else if (input.kind === "chat") {
      fallback.searchParams.set("path", "__chat__");
    } else {
      const appSlug = parsed.pathname.match(/^\/desktop\/apps\/([a-z0-9][a-z0-9-]{0,63})$/)?.[1];
      if (appSlug) fallback.searchParams.set("path", `apps/${appSlug}/index.html`);
    }
    return fallback.toString();
  }

  private async recoverStandaloneRoute404(tab: DesktopWorkbenchTabRecord): Promise<void> {
    if (!tab.fallbackUrl || tab.fallbackAttempted || !tab.view.webContents.getURL().includes("/desktop/")) return;
    try {
      const pageSignal = await tab.view.webContents.executeJavaScript(
        `({ title: document.title, text: document.body?.innerText?.slice(0, 240) ?? "" })`,
      ) as { title?: string; text?: string };
      const content = `${pageSignal.title ?? ""}\n${pageSignal.text ?? ""}`;
      if (!/\b404\b|could not be found/i.test(content)) return;
      tab.fallbackAttempted = true;
      tab.url = tab.fallbackUrl;
      await tab.view.webContents.loadURL(tab.fallbackUrl);
      this.emitSnapshot();
    } catch (err: unknown) {
      console.warn("[desktop] Failed to recover standalone desktop route", err instanceof Error ? err.name : "UnknownError");
    }
  }
}

async function listWorkbenchApps(): Promise<DesktopWorkbenchApp[]> {
  const apps = [...BUILTIN_APPS];
  try {
    const response = await fetch(new URL("/api/apps", desktopConfig.gatewayUrl), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return apps;
    const entries = await response.json() as Array<{ name?: unknown; slug?: unknown; category?: unknown; launchUrl?: unknown }>;
    for (const entry of entries) {
      if (typeof entry.name !== "string" || typeof entry.slug !== "string") continue;
      if (!APP_SLUG_RE.test(entry.slug)) continue;
      if (apps.some((app) => app.id === entry.slug)) continue;
      apps.push({
        id: entry.slug,
        name: entry.name.trim().slice(0, 80) || entry.slug,
        url: `/desktop/apps/${entry.slug}`,
        kind: "app",
        category: typeof entry.category === "string" ? entry.category : "app",
        defaultApp: false,
      });
    }
  } catch (err: unknown) {
    console.warn("[desktop] Failed to list Matrix apps", err instanceof Error ? err.name : "UnknownError");
  }
  return apps;
}

function registerDesktopIpc(): void {
  ipcMain.handle("matrix-desktop:get-runtime-policy", () => desktopRuntimePolicy);
  ipcMain.handle("matrix-desktop:open-external", async (_event, url: unknown) => {
    if (typeof url !== "string") return { ok: false };
    return { ok: await openAllowedExternalUrl(url, { openExternal: (target) => shell.openExternal(target) }) };
  });
  ipcMain.handle("matrix-desktop:get-workbench-snapshot", () => currentWorkbenchSnapshot());
  ipcMain.handle("matrix-desktop:list-workbench-apps", () => listWorkbenchApps());
  ipcMain.handle("matrix-desktop:open-workbench-tab", (_event, input: unknown) => {
    const sanitized = sanitizeTabInput(input);
    return sanitized && workbench ? workbench.openTab(sanitized) : currentWorkbenchSnapshot();
  });
  ipcMain.handle("matrix-desktop:focus-workbench-tab", (_event, id: unknown) =>
    typeof id === "string" && workbench ? workbench.focusTab(id) : currentWorkbenchSnapshot());
  ipcMain.handle("matrix-desktop:close-workbench-tab", (_event, id: unknown) =>
    typeof id === "string" && workbench ? workbench.closeTab(id) : currentWorkbenchSnapshot());
  ipcMain.handle("matrix-desktop:set-workbench-chrome-height", (_event, height: unknown) =>
    workbench ? workbench.setChromeHeight(normalizeChromeHeight(height)) : currentWorkbenchSnapshot());
}

async function createMainWindow(): Promise<BrowserWindow> {
  const windowState = await loadDesktopWindowState(windowStatePath());
  const launchPlan = createDesktopLaunchPlan(desktopConfig, windowState);
  const allowedShellOrigins = new Set(launchPlan.allowedOrigins);
  const win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Matrix Desktop",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, "../preload/index.js"),
    },
  });

  workbench = new DesktopWorkbench(win, allowedShellOrigins);

  win.once("ready-to-show", () => {
    if (windowState.maximized) {
      win.maximize();
    }
    win.show();
  });

  let windowStateSaved = false;
  win.on("close", (event) => {
    if (windowStateSaved) return;
    event.preventDefault();
    const bounds = win.getBounds();
    const nextState: DesktopWindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
      lastLoadedUrl: launchPlan.loadUrl,
    };
    void saveDesktopWindowState(windowStatePath(), nextState)
      .catch((err: unknown) => {
        console.warn("[desktop] Failed to save window state", err instanceof Error ? err.name : "UnknownError");
      })
      .finally(() => {
        windowStateSaved = true;
        win.close();
      });
  });

  await win.loadURL(rendererEntryUrl());
  workbench.openTab({ title: "Matrix Shell", url: launchPlan.loadUrl, kind: "shell" });
  return win;
}

registerDesktopIpc();

app.whenReady().then(() => {
  void createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
