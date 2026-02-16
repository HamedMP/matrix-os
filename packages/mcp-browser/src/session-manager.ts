export interface BrowserSession {
  id: string;
  browser: BrowserLike;
  page: PageLike;
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
  context(): { pages(): PageLike[]; newPage(): Promise<PageLike>; close(): Promise<void> };
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  contexts(): Array<{ pages(): PageLike[] }>;
}

type Launcher = (opts?: { headless?: boolean }) => Promise<BrowserLike>;

export interface SessionManagerOptions {
  launcher: Launcher;
  headless?: boolean;
  idleTimeoutMs?: number;
  timeout?: number;
}

export class SessionManager {
  private session: BrowserSession | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private launcher: Launcher;
  private headless: boolean;
  private idleTimeoutMs: number;
  private timeout: number;
  private consoleMessages: Array<{ type: string; text: string }> = [];

  constructor(opts: SessionManagerOptions) {
    this.launcher = opts.launcher;
    this.headless = opts.headless ?? true;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60 * 1000;
    this.timeout = opts.timeout ?? 30000;
  }

  async launch(): Promise<BrowserSession> {
    if (this.session) return this.session;

    const browser = await this.launcher({ headless: this.headless });
    const page = await browser.newPage();
    page.setDefaultTimeout(this.timeout);

    this.consoleMessages = [];
    page.on("console", (msg: unknown) => {
      const m = msg as { type(): string; text(): string };
      this.consoleMessages.push({ type: m.type(), text: m.text() });
      if (this.consoleMessages.length > 100) {
        this.consoleMessages.shift();
      }
    });

    const session: BrowserSession = {
      id: `session_${Date.now()}`,
      browser,
      page,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.session = session;
    this.resetIdleTimer();
    return session;
  }

  getActive(): BrowserSession | undefined {
    return this.session;
  }

  getPage(): PageLike | undefined {
    return this.session?.page;
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
      await this.session.browser.close().catch(() => {});
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
