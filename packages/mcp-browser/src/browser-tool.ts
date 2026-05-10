import { mkdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionManager, type BrowserLike, type PageLike } from "./session-manager.js";
import { formatAccessibilityTree, type AXNode } from "./role-snapshot.js";
import { wrapBrowserExternalContent } from "./external-content.js";
import {
  assertSafeBrowserUrl,
  isBrowserInputError,
  normalizeBrowserProfileName,
  resolveBrowserArtifactPath,
  type ResolveHostname,
} from "./security.js";

const REQUEST_GUARD_INSTALLED = Symbol("matrixBrowserRequestGuardInstalled");

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

type Launcher = (opts?: { headless?: boolean }) => Promise<BrowserLike>;

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
  const defaultProfile = opts.defaultProfile ?? "default";
  const manager = new SessionManager({
    launcher: opts.launcher,
    headless: opts.headless ?? true,
    idleTimeoutMs: opts.idleTimeoutMs ?? 300_000,
    timeout: opts.timeout ?? 30_000,
    profileRoot: join(opts.homePath, "data", "browser-profiles"),
    defaultProfile,
  });
  const guardedContexts = new WeakSet<object>();

  async function handleGuardedRequest(route: {
    request(): { url(): string };
    continue(): Promise<void>;
    abort(errorCode?: string): Promise<void>;
  }): Promise<void> {
    try {
      await assertSafeBrowserUrl(route.request().url(), { resolveHostname: opts.resolveHostname });
      await route.continue();
    } catch (error) {
      console.warn(
        "[mcp-browser] Blocked browser request:",
        error instanceof Error ? error.message : "unsafe request",
      );
      await route.abort("blockedbyclient");
    }
  }

  async function installRequestGuard(page: PageLike): Promise<void> {
    const context = page.context();
    if (context.route) {
      if (guardedContexts.has(context)) return;
      await context.route("**/*", handleGuardedRequest);
      guardedContexts.add(context);
      return;
    }

    const guardedPage = page as PageLike & { [REQUEST_GUARD_INSTALLED]?: boolean };
    if (!page.route || guardedPage[REQUEST_GUARD_INSTALLED]) return;
    await page.route("**/*", handleGuardedRequest);
    guardedPage[REQUEST_GUARD_INSTALLED] = true;
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

  async function execute(input: BrowserToolInput): Promise<BrowserToolResult> {
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
          const safeUrl = await assertSafeBrowserUrl(input.url, { resolveHostname: opts.resolveHostname });
          const session = await ensureSession(input.profile);
          const page = session.page;
          await page.goto(safeUrl, { waitUntil: "domcontentloaded" });
          const title = await page.title();
          const url = page.url();

          const tree = await page.accessibility.snapshot() as AXNode | null;
          const snapshot = formatAccessibilityTree(tree);

          return {
            action,
            success: true,
            title,
            url,
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
            const safeUrl = await assertSafeBrowserUrl(input.url, { resolveHostname: opts.resolveHostname });
            await newPage.goto(safeUrl, { waitUntil: "domcontentloaded" });
          }
          return { action, success: true, content: "New tab opened" };
        }

        case "tab_close": {
          const session = await ensureSession(input.profile);
          await session.page.close();
          return { action, success: true, content: "Tab closed" };
        }

        case "tab_switch": {
          const session = await ensureSession(input.profile);
          const ctx = session.page.context();
          const pages = ctx.pages();
          const index = parseInt(input.value ?? "0", 10);
          if (index >= 0 && index < pages.length) {
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

  return { execute, close: () => manager.close() };
}
