import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeBrowserProfileName } from "./security.js";

export interface BrowserSession {
  id: string;
  browser: BrowserLike;
  page: PageLike;
  profile?: string;
  profilePath?: string;
  createdAt: number;
  lastActivity: number;
}

export interface PageLike {
  goto(url: string, opts?: Record<string, unknown>): Promise<{ status(): number } | null>;
  title(): Promise<string>;
  url(): string;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  pdf(opts?: Record<string, unknown>): Promise<Buffer>;
  content(): Promise<string>;
  evaluate(expr: string | (() => unknown)): Promise<unknown>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<void>;
  getByRole(role: string, opts?: { name?: string }): { click(): Promise<void> };
  waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<void>;
  waitForNavigation(opts?: Record<string, unknown>): Promise<void>;
  waitForLoadState(state?: string): Promise<void>;
  setDefaultTimeout(ms: number): void;
  close(): Promise<void>;
  mouse: { wheel(opts: { deltaX: number; deltaY: number }): Promise<void> };
  accessibility: { snapshot(): Promise<unknown> };
  on(event: string, handler: (...args: unknown[]) => void): void;
  route?(
    url: string,
    handler: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(errorCode?: string): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
  context(): BrowserContextLike;
}

export interface BrowserContextLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  route?(
    url: string,
    handler: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(errorCode?: string): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  contexts(): Array<BrowserContextLike>;
}

type Launcher = (opts?: { headless?: boolean; userDataDir?: string }) => Promise<BrowserLike>;

export interface SessionManagerOptions {
  launcher: Launcher;
  headless?: boolean;
  idleTimeoutMs?: number;
  timeout?: number;
  profileRoot?: string;
  defaultProfile?: string;
}

export class SessionManager {
  private session: BrowserSession | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private launching: { profile: string; promise: Promise<BrowserSession> } | undefined;
  private launcher: Launcher;
  private headless: boolean;
  private idleTimeoutMs: number;
  private timeout: number;
  private profileRoot: string | undefined;
  private defaultProfile: string;
  private consoleMessages: Array<{ type: string; text: string }> = [];
  private consolePages = new WeakSet<PageLike>();

  constructor(opts: SessionManagerOptions) {
    this.launcher = opts.launcher;
    this.headless = opts.headless ?? true;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60 * 1000;
    this.timeout = opts.timeout ?? 30000;
    this.profileRoot = opts.profileRoot ? resolve(opts.profileRoot) : undefined;
    this.defaultProfile = opts.defaultProfile ?? "default";
  }

  async launch(opts: { profile?: string } = {}): Promise<BrowserSession> {
    const profile = normalizeBrowserProfileName(opts.profile, this.defaultProfile);
    if (this.launching) {
      if (this.launching.profile === profile) return this.launching.promise;
      try {
        await this.launching.promise;
      } catch (error: unknown) {
        console.warn(
          "[mcp-browser] Previous browser launch failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
      return this.launch({ profile });
    }
    if (this.session?.profile === profile) return this.session;

    const promise = this.openSession(profile).finally(() => {
      if (this.launching?.promise === promise) {
        this.launching = undefined;
      }
    });
    this.launching = { profile, promise };

    return promise;
  }

  private async openSession(profile: string): Promise<BrowserSession> {
    if (this.session) {
      await this.close();
    }

    const profilePath = this.profileRoot ? join(this.profileRoot, profile) : undefined;
    if (profilePath) {
      await mkdir(profilePath, { recursive: true, mode: 0o700 });
    }

    const browser = await this.launcher({
      headless: this.headless,
      ...(profilePath ? { userDataDir: profilePath } : {}),
    });
    const page = this.getInitialPage(browser) ?? await browser.newPage();

    this.consoleMessages = [];
    this.preparePage(page);

    const session: BrowserSession = {
      id: `session_${randomUUID()}`,
      browser,
      page,
      profile,
      ...(profilePath ? { profilePath } : {}),
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.session = session;
    this.resetIdleTimer();
    return session;
  }

  private preparePage(page: PageLike): void {
    page.setDefaultTimeout(this.timeout);
    if (this.consolePages.has(page)) return;

    page.on("console", (msg: unknown) => {
      const m = msg as { type(): string; text(): string };
      this.consoleMessages.push({ type: m.type(), text: m.text() });
      if (this.consoleMessages.length > 100) {
        this.consoleMessages.shift();
      }
    });
    this.consolePages.add(page);
  }

  private getInitialPage(browser: BrowserLike): PageLike | undefined {
    for (const context of browser.contexts()) {
      const page = context.pages()[0];
      if (page) return page;
    }
    return undefined;
  }

  getActive(): BrowserSession | undefined {
    return this.session;
  }

  getPage(): PageLike | undefined {
    return this.session?.page;
  }

  setActivePage(page: PageLike): void {
    if (!this.session) return;
    this.preparePage(page);
    this.session.page = page;
    this.touch();
  }

  getConsoleMessages(): Array<{ type: string; text: string }> {
    return [...this.consoleMessages];
  }

  touch(): void {
    if (this.session) {
      this.session.lastActivity = Date.now();
      this.resetIdleTimer();
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.session) {
      await this.session.browser.close().catch((err: unknown) => {
        console.warn("[mcp-browser] Browser close failed:", err instanceof Error ? err.message : String(err));
      });
      this.session = undefined;
    }
    this.consoleMessages = [];
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.close();
    }, this.idleTimeoutMs);
  }
}
