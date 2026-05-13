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
  lockDeviceId?: string;
  focusSurfaceId?: string;
  surfaces?: Map<string, BrowserSurface>;
}

export interface BrowserSurface {
  id: string;
  deviceId: string;
  kind: "canvas" | "standalone";
  lastTouched: number;
}

type BrowserRoutePattern = string | RegExp | ((url: URL) => boolean);

export interface BrowserRequestRouteLike {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export interface BrowserWebSocketRouteLike {
  url(): string;
  connectToServer(): unknown;
  close(options?: { code?: number; reason?: string }): Promise<void> | void;
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
    url: BrowserRoutePattern,
    handler: (route: BrowserRequestRouteLike) => Promise<void> | void,
  ): Promise<void>;
  routeWebSocket?(
    url: BrowserRoutePattern,
    handler: (route: BrowserWebSocketRouteLike) => Promise<void> | void,
  ): Promise<void>;
  context(): BrowserContextLike;
}

export interface BrowserContextLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  route?(
    url: BrowserRoutePattern,
    handler: (route: BrowserRequestRouteLike) => Promise<void> | void,
  ): Promise<void>;
  routeWebSocket?(
    url: BrowserRoutePattern,
    handler: (route: BrowserWebSocketRouteLike) => Promise<void> | void,
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
  maxSurfaces?: number;
}

export class SessionManager {
  private session: BrowserSession | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private launching: { profile: string; deviceId?: string; sessionId?: string; promise: Promise<BrowserSession> } | undefined;
  private launcher: Launcher;
  private headless: boolean;
  private idleTimeoutMs: number;
  private timeout: number;
  private profileRoot: string | undefined;
  private defaultProfile: string;
  private maxSurfaces: number;
  private surfaceIdleMs: number;
  private consoleMessages: Array<{ type: string; text: string }> = [];
  private consolePages = new WeakSet<PageLike>();
  private actionQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: SessionManagerOptions) {
    this.launcher = opts.launcher;
    this.headless = opts.headless ?? true;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60 * 1000;
    this.timeout = opts.timeout ?? 30000;
    this.profileRoot = opts.profileRoot ? resolve(opts.profileRoot) : undefined;
    this.defaultProfile = normalizeBrowserProfileName(opts.defaultProfile, "default");
    this.maxSurfaces = opts.maxSurfaces ?? 3;
    this.surfaceIdleMs = opts.idleTimeoutMs ?? 5 * 60 * 1000;
  }

  async launch(opts: { profile?: string; deviceId?: string; sessionId?: string } = {}): Promise<BrowserSession> {
    const profile = normalizeBrowserProfileName(opts.profile, this.defaultProfile);
    if (this.launching) {
      if (this.launching.profile === profile) {
        if (
          opts.deviceId &&
          this.launching.deviceId &&
          this.launching.deviceId !== opts.deviceId
        ) {
          throw new BrowserProfileLockedError("Browser profile is opening on another device");
        }
        return this.launching.promise;
      }
      try {
        await this.launching.promise;
      } catch (error: unknown) {
        console.warn(
          "[mcp-browser] Previous browser launch failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
      return this.launch({ profile, deviceId: opts.deviceId, sessionId: opts.sessionId });
    }
    if (this.session?.profile === profile) {
      if (opts.deviceId && this.session.lockDeviceId && this.session.lockDeviceId !== opts.deviceId) {
        throw new BrowserProfileLockedError("Browser profile is open on another device");
      }
      return this.session;
    }
    if (this.session?.lockDeviceId && opts.deviceId && this.session.lockDeviceId !== opts.deviceId) {
      throw new BrowserProfileLockedError("Browser profile is open on another device");
    }

    const promise = this.openSession(profile, opts.deviceId, opts.sessionId).finally(() => {
      if (this.launching?.promise === promise) {
        this.launching = undefined;
      }
    });
    this.launching = { profile, deviceId: opts.deviceId, sessionId: opts.sessionId, promise };

    return promise;
  }

  private async openSession(profile: string, deviceId?: string, sessionId?: string): Promise<BrowserSession> {
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
      id: sessionId ?? `session_${randomUUID()}`,
      browser,
      page,
      profile,
      ...(deviceId ? { lockDeviceId: deviceId } : {}),
      surfaces: new Map(),
      ...(profilePath ? { profilePath } : {}),
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.session = session;
    this.resetIdleTimer();
    return session;
  }

  attachSurface(opts: {
    sessionId: string;
    surfaceId: string;
    deviceId: string;
    kind: "canvas" | "standalone";
  }): BrowserSurface {
    if (!this.session || this.session.id !== opts.sessionId) {
      throw new BrowserSessionError("Browser session not found");
    }
    if (this.session.lockDeviceId && this.session.lockDeviceId !== opts.deviceId) {
      throw new BrowserProfileLockedError("Browser profile is open on another device");
    }
    this.session.lockDeviceId = opts.deviceId;
    this.sweepStaleSurfaces();
    const surface: BrowserSurface = {
      id: opts.surfaceId,
      deviceId: opts.deviceId,
      kind: opts.kind,
      lastTouched: Date.now(),
    };
    this.session.surfaces ??= new Map();
    if (!this.session.surfaces.has(opts.surfaceId) && this.session.surfaces.size >= this.maxSurfaces) {
      throw new BrowserStreamLimitError("Browser stream limit reached");
    }
    this.session.surfaces.set(opts.surfaceId, surface);
    if (!this.session.focusSurfaceId) {
      this.session.focusSurfaceId = opts.surfaceId;
    }
    this.touch();
    return surface;
  }

  focusSurface(surfaceId: string): void {
    const surface = this.session?.surfaces?.get(surfaceId);
    if (!this.session || !surface) {
      throw new BrowserSessionError("Browser surface not found");
    }
    surface.lastTouched = Date.now();
    this.session.focusSurfaceId = surfaceId;
    this.touch();
  }

  detachSurface(surfaceId: string): void {
    if (!this.session?.surfaces) return;
    this.session.surfaces.delete(surfaceId);
    if (this.session.focusSurfaceId === surfaceId) {
      const nextSurfaceId = this.session.surfaces.keys().next().value;
      if (nextSurfaceId) {
        this.session.focusSurfaceId = nextSurfaceId;
      } else {
        delete this.session.focusSurfaceId;
      }
    }
    this.touch();
  }

  assertFocusedSurface(surfaceId: string): void {
    if (!this.session || this.session.focusSurfaceId !== surfaceId) {
      throw new BrowserStaleFocusError("Browser input came from a background surface");
    }
  }

  async enqueueAction<T>(
    run: () => Promise<T>,
    opts: { surfaceId?: string; agent?: boolean } = {},
  ): Promise<T> {
    if (!opts.agent && opts.surfaceId) {
      this.assertFocusedSurface(opts.surfaceId);
    }
    const previous = this.actionQueue;
    const ready = previous.catch((error: unknown) => {
      console.warn(
        "[mcp-browser] Previous browser action failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
    const queued = ready.then(async () => {
      if (!opts.agent && opts.surfaceId) {
        this.assertFocusedSurface(opts.surfaceId);
      }
      return await run();
    });
    const drain = queued.catch((error: unknown) => {
      console.warn(
        "[mcp-browser] Browser action failed:",
        error instanceof Error ? error.message : String(error),
      );
    }).finally(() => {
      if (this.actionQueue === drain) {
        this.actionQueue = Promise.resolve();
      }
      this.touch();
    });
    this.actionQueue = drain;
    return await queued;
  }

  takeover(opts: { deviceId: string }): BrowserSession | undefined {
    if (!this.session) return undefined;
    this.session.lockDeviceId = opts.deviceId;
    this.session.focusSurfaceId = undefined;
    this.session.surfaces?.clear();
    this.touch();
    return this.session;
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

  private sweepStaleSurfaces(now = Date.now()): void {
    const surfaces = this.session?.surfaces;
    if (!surfaces) return;
    for (const [surfaceId, surface] of surfaces.entries()) {
      if (now - surface.lastTouched > this.surfaceIdleMs) {
        surfaces.delete(surfaceId);
      }
    }
    if (this.session?.focusSurfaceId && !surfaces.has(this.session.focusSurfaceId)) {
      const nextSurfaceId = surfaces.keys().next().value;
      if (nextSurfaceId) {
        this.session.focusSurfaceId = nextSurfaceId;
      } else {
        delete this.session.focusSurfaceId;
      }
    }
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

export class BrowserSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSessionError";
  }
}

export class BrowserProfileLockedError extends BrowserSessionError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserProfileLockedError";
  }
}

export class BrowserStaleFocusError extends BrowserSessionError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserStaleFocusError";
  }
}

export class BrowserStreamLimitError extends BrowserSessionError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserStreamLimitError";
  }
}
