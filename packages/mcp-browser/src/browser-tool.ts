import { mkdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SessionManager,
  type BrowserLike,
  type BrowserRequestRouteLike,
  type BrowserWebSocketRouteLike,
  type PageLike,
} from "./session-manager.js";
import { formatAccessibilityTree, type AXNode } from "./role-snapshot.js";
import { wrapBrowserExternalContent } from "./external-content.js";
import {
  assertSafeBrowserWebSocketUrl,
  assertSafeBrowserUrl,
  isBrowserInputError,
  normalizeBrowserProfileName,
  resolveBrowserArtifactPath,
  resolveBrowserHostname,
  type ResolveHostname,
} from "./security.js";

const REQUEST_GUARD_INSTALLED = Symbol("matrixBrowserRequestGuardInstalled");
const WEBSOCKET_GUARD_INSTALLED = Symbol("matrixBrowserWebSocketGuardInstalled");

export type BrowserAction =
  | "launch"
  | "close"
  | "navigate"
  | "screenshot"
  | "snapshot"
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "evaluate"
  | "wait"
  | "tabs"
  | "tab_new"
  | "tab_close"
  | "tab_switch"
  | "pdf"
  | "console"
  | "status";

export interface BrowserToolInput {
  action: BrowserAction;
  url?: string;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  expression?: string;
  timeout?: number;
  fullPage?: boolean;
  path?: string;
  profile?: string;
}

export interface BrowserToolResult {
  action: string;
  success: boolean;
  title?: string;
  url?: string;
  content?: string;
  screenshotPath?: string;
  error?: string;
}

type Launcher = (opts?: { headless?: boolean; userDataDir?: string }) => Promise<BrowserLike>;

export interface BrowserToolOptions {
  homePath: string;
  launcher: Launcher;
  headless?: boolean;
  idleTimeoutMs?: number;
  timeout?: number;
  defaultProfile?: string;
  resolveHostname?: ResolveHostname;
}

function wrapBrowserContent(content: string): string {
  return wrapBrowserExternalContent(content);
}

export function createBrowserTool(opts: BrowserToolOptions) {
  const defaultProfile = normalizeBrowserProfileName(opts.defaultProfile, "default");
  const resolveHostname = opts.resolveHostname ?? resolveBrowserHostname;
  let actionQueue: Promise<void> = Promise.resolve();
  const manager = new SessionManager({
    launcher: opts.launcher,
    headless: opts.headless ?? true,
    idleTimeoutMs: opts.idleTimeoutMs ?? 300_000,
    timeout: opts.timeout ?? 30_000,
    profileRoot: join(opts.homePath, "data", "browser-profiles"),
    defaultProfile,
  });
  const guardedRequestContexts = new WeakSet<object>();
  const guardedWebSocketContexts = new WeakSet<object>();

  async function handleGuardedRequest(route: BrowserRequestRouteLike): Promise<void> {
    try {
      await assertSafeBrowserUrl(route.request().url(), { resolveHostname });
      await route.continue();
    } catch (error) {
      console.warn(
        "[mcp-browser] Blocked browser request:",
        error instanceof Error ? error.message : "unsafe request",
      );
      await route.abort("blockedbyclient");
    }
  }

  async function handleGuardedWebSocket(route: BrowserWebSocketRouteLike): Promise<void> {
    try {
      await assertSafeBrowserWebSocketUrl(route.url(), { resolveHostname });
      route.connectToServer();
    } catch (error) {
      console.warn(
        "[mcp-browser] Blocked browser WebSocket:",
        error instanceof Error ? error.message : "unsafe WebSocket",
      );
      await route.close({ code: 1008, reason: "blocked" });
    }
  }

  async function installRequestGuard(page: PageLike): Promise<void> {
    const context = page.context();
    let needsPageRequestGuard = true;
    let needsPageWebSocketGuard = true;

    if (context.route) {
      needsPageRequestGuard = false;
      if (!guardedRequestContexts.has(context)) {
        await context.route("**/*", handleGuardedRequest);
        guardedRequestContexts.add(context);
      }
    }

    if (context.routeWebSocket) {
      needsPageWebSocketGuard = false;
      if (!guardedWebSocketContexts.has(context)) {
        await context.routeWebSocket("**/*", handleGuardedWebSocket);
        guardedWebSocketContexts.add(context);
      }
    }

    const guardedPage = page as PageLike & {
      [REQUEST_GUARD_INSTALLED]?: boolean;
      [WEBSOCKET_GUARD_INSTALLED]?: boolean;
    };

    if (needsPageRequestGuard && page.route && !guardedPage[REQUEST_GUARD_INSTALLED]) {
      await page.route("**/*", handleGuardedRequest);
      guardedPage[REQUEST_GUARD_INSTALLED] = true;
    }

    if (needsPageWebSocketGuard && page.routeWebSocket && !guardedPage[WEBSOCKET_GUARD_INSTALLED]) {
      await page.routeWebSocket("**/*", handleGuardedWebSocket);
      guardedPage[WEBSOCKET_GUARD_INSTALLED] = true;
    }
  }

  async function ensureSession(profile?: string) {
    const requestedProfile = normalizeBrowserProfileName(profile, defaultProfile);
    let session = manager.getActive();
    if (!session || session.profile !== requestedProfile) {
      session = await manager.launch({ profile: requestedProfile });
    }
    await installRequestGuard(session.page);
    manager.touch();
    return session;
  }

  async function serializeAction<T>(run: () => Promise<T>): Promise<T> {
    const previous = actionQueue;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current, () => current);
    actionQueue = queued;

    try {
      await previous;
    } catch (error: unknown) {
      console.warn(
        "[mcp-browser] Previous browser action failed:",
        error instanceof Error ? error.message : String(error),
      );
    }

    try {
      return await run();
    } finally {
      release();
      if (actionQueue === queued) {
        actionQueue = Promise.resolve();
      }
    }
  }

  async function executeAction(input: BrowserToolInput): Promise<BrowserToolResult> {
    const { action } = input;

    try {
      switch (action) {
        case "launch": {
          const session = await manager.launch({ profile: input.profile });
          await installRequestGuard(session.page);
          return { action, success: true, content: "Browser session started" };
        }

        case "close": {
          await manager.close();
          return { action, success: true, content: "Browser session closed" };
        }

        case "status": {
          const session = manager.getActive();
          if (!session) {
            return { action, success: true, content: "No active browser session" };
          }
          const page = session.page;
          return {
            action,
            success: true,
            content: `Browser: active\nProfile: ${session.profile ?? "default"}\nURL: ${page.url()}\nSession: ${session.id}\nUptime: ${Math.round((Date.now() - session.createdAt) / 1000)}s`,
          };
        }

        case "navigate": {
          if (!input.url) {
            return { action, success: false, error: "navigate requires a url" };
          }
          const safeUrl = await assertSafeBrowserUrl(input.url, { resolveHostname });
          const session = await ensureSession(input.profile);
          const page = session.page;
          await page.goto(safeUrl, { waitUntil: "domcontentloaded" });
          const title = await page.title();
          const url = page.url();

          const tree = await page.accessibility.snapshot() as AXNode | null;
          const snapshot = formatAccessibilityTree(tree);

          const screenshotDir = join(opts.homePath, "data", "screenshots");
          await mkdir(screenshotDir, { recursive: true, mode: 0o700 });
          const ssFilename = `nav-${Date.now()}.png`;
          const ssPath = join(screenshotDir, ssFilename);
          await page.screenshot({ fullPage: false, path: ssPath });

          return {
            action,
            success: true,
            title,
            url,
            screenshotPath: ssPath,
            content: wrapBrowserContent(snapshot),
          };
        }

        case "snapshot": {
          const session = await ensureSession(input.profile);
          const page = session.page;
          const tree = await page.accessibility.snapshot() as AXNode | null;
          const snapshot = formatAccessibilityTree(tree);
          return {
            action,
            success: true,
            title: await page.title(),
            url: page.url(),
            content: wrapBrowserContent(snapshot),
          };
        }

        case "click": {
          const session = await ensureSession(input.profile);
          const page = session.page;

          if (input.role && input.name) {
            const el = page.getByRole(input.role, { name: input.name });
            await el.click();
          } else if (input.selector) {
            await page.click(input.selector);
          } else {
            return { action, success: false, error: "click requires selector or role+name" };
          }

          const tree = await page.accessibility.snapshot() as AXNode | null;
          return {
            action,
            success: true,
            content: wrapBrowserContent(formatAccessibilityTree(tree)),
          };
        }

        case "type": {
          if (!input.selector || input.text === undefined) {
            return { action, success: false, error: "type requires selector and text" };
          }
          const session = await ensureSession(input.profile);
          const page = session.page;
          await page.fill(input.selector, input.text);

          const tree = await page.accessibility.snapshot() as AXNode | null;
          return {
            action,
            success: true,
            content: wrapBrowserContent(formatAccessibilityTree(tree)),
          };
        }

        case "select": {
          if (!input.selector || !input.value) {
            return { action, success: false, error: "select requires selector and value" };
          }
          const session = await ensureSession(input.profile);
          await session.page.selectOption(input.selector, input.value);

          const tree = await session.page.accessibility.snapshot() as AXNode | null;
          return {
            action,
            success: true,
            content: wrapBrowserContent(formatAccessibilityTree(tree)),
          };
        }

        case "screenshot": {
          const session = await ensureSession(input.profile);
          const page = session.page;
          const buffer = await page.screenshot({ fullPage: input.fullPage ?? true });

          const filename = `${Date.now()}.png`;
          const filepath = resolveBrowserArtifactPath(opts.homePath, filename, input.path);
          await mkdir(dirname(filepath), { recursive: true, mode: 0o700 });
          await writeFile(filepath, buffer);

          return { action, success: true, screenshotPath: filepath };
        }

        case "pdf": {
          const session = await ensureSession(input.profile);
          const page = session.page;
          const buffer = await page.pdf();

          const filename = `${Date.now()}.pdf`;
          const filepath = resolveBrowserArtifactPath(opts.homePath, filename, input.path);
          await mkdir(dirname(filepath), { recursive: true, mode: 0o700 });
          await writeFile(filepath, buffer);

          return { action, success: true, screenshotPath: filepath };
        }

        case "evaluate": {
          if (!input.expression) {
            return { action, success: false, error: "evaluate requires expression" };
          }
          const session = await ensureSession(input.profile);
          const result = await session.page.evaluate(input.expression);
          const text = typeof result === "string" ? result : JSON.stringify(result);
          return {
            action,
            success: true,
            content: wrapBrowserContent(text),
          };
        }

        case "wait": {
          const session = await ensureSession(input.profile);
          const page = session.page;
          const timeout = input.timeout ?? 30_000;

          if (input.selector) {
            await page.waitForSelector(input.selector, { timeout });
          } else {
            await page.waitForLoadState("networkidle");
          }
          return { action, success: true, content: "Wait completed" };
        }

        case "scroll": {
          const session = await ensureSession(input.profile);
          const page = session.page;
          await page.mouse.wheel({ deltaX: 0, deltaY: 500 });
          return { action, success: true, content: "Scrolled down" };
        }

        case "tabs": {
          const session = await ensureSession(input.profile);
          const ctx = session.page.context();
          const pages = ctx.pages();
          const tabInfo = pages.map((p, i) => `${i}: ${p.url()}`);
          return {
            action,
            success: true,
            content: tabInfo.length > 0 ? tabInfo.join("\n") : "No tabs",
          };
        }

        case "tab_new": {
          const session = await ensureSession(input.profile);
          const ctx = session.page.context();
          const newPage = await ctx.newPage();
          await installRequestGuard(newPage);
          if (input.url) {
            const safeUrl = await assertSafeBrowserUrl(input.url, { resolveHostname });
            await newPage.goto(safeUrl, { waitUntil: "domcontentloaded" });
          }
          return { action, success: true, content: "New tab opened" };
        }

        case "tab_close": {
          const session = await ensureSession(input.profile);
          const ctx = session.page.context();
          const pages = ctx.pages();
          const currentIndex = pages.indexOf(session.page);
          const index = input.value === undefined ? Math.max(currentIndex, 0) : parseInt(input.value, 10);

          if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
            return { action, success: false, error: `Invalid tab index: ${input.value ?? index}` };
          }

          const closingPage = pages[index];
          const closingActivePage = closingPage === session.page;
          await closingPage.close();

          const remainingPages = ctx.pages().filter((page) => page !== closingPage);
          if (remainingPages.length === 0) {
            await manager.close();
            return { action, success: true, content: "Tab closed; browser session closed" };
          }

          if (closingActivePage) {
            const nextPage = remainingPages[Math.min(index, remainingPages.length - 1)];
            await installRequestGuard(nextPage);
            manager.setActivePage(nextPage);
          }

          return { action, success: true, content: "Tab closed" };
        }

        case "tab_switch": {
          const session = await ensureSession(input.profile);
          const ctx = session.page.context();
          const pages = ctx.pages();
          const index = parseInt(input.value ?? "0", 10);
          if (index >= 0 && index < pages.length) {
            const nextPage = pages[index];
            await installRequestGuard(nextPage);
            manager.setActivePage(nextPage);
            return { action, success: true, content: `Switched to tab ${index}` };
          }
          return { action, success: false, error: `Invalid tab index: ${index}` };
        }

        case "console": {
          const messages = manager.getConsoleMessages();
          const text = messages.length > 0
            ? messages.map((m) => `[${m.type}] ${m.text}`).join("\n")
            : "No console messages";
          return {
            action,
            success: true,
            content: wrapBrowserContent(text),
          };
        }

        default:
          return { action: String(action), success: false, error: `Unknown action: ${action}` };
      }
    } catch (e) {
      if (isBrowserInputError(e)) {
        return {
          action: String(action),
          success: false,
          error: e.message,
        };
      }

      console.warn("[mcp-browser] Browser action failed:", e instanceof Error ? e.message : String(e));
      return {
        action: String(action),
        success: false,
        error: "Browser action failed",
      };
    }
  }

  async function execute(input: BrowserToolInput): Promise<BrowserToolResult> {
    return serializeAction(() => executeAction(input));
  }

  return { execute, close: () => manager.close() };
}
