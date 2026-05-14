import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  assertRuntimeRequestMatchesPolicy,
  createBrowserNavigationPolicy,
  createChromiumHostResolverRules,
  type BrowserNavigationPolicyBinding,
  type ResolveHostname,
} from "./security.js";
import { chromiumBrowserLaunchArgs } from "./media-service.js";
import { SessionManager, type BrowserLike, type PageLike } from "./session-manager.js";
import { parseBrowserClientMessage, type BrowserClientMessage } from "./stream-protocol.js";

const RUNTIME_NAVIGATION_TIMEOUT_MS = 7_000;
const RUNTIME_FRAME_CAPTURE_TIMEOUT_MS = 3_000;
const DEFAULT_BROWSER_VIEWPORT_WIDTH = 1365;
const DEFAULT_BROWSER_VIEWPORT_HEIGHT = 768;
const DEFAULT_BROWSER_LOCALE = "en-US";

export interface BrowserRuntimeSessionState {
  id: string;
  profile: string;
  profilePath?: string;
  currentUrl: string;
  lastActivity: string;
  state: "active" | "hibernated" | "recoverable";
  tabs: BrowserRuntimeTabState[];
}

export interface BrowserRuntimeTabState {
  id: string;
  url: string;
  title: string | null;
  order: number;
}

export interface BrowserRuntimeDownloadState {
  id: string;
  filename: string;
  state: "staged" | "complete" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface BrowserRuntimeResourceUsage {
  memoryBytes?: number;
  profileBytes?: number;
  downloads?: number;
  streams?: number;
  sessions?: number;
}

export interface BrowserRuntimeFrame {
  sessionId: string;
  url: string;
  mimeType: "image/jpeg";
  data: string;
  capturedAt: string;
}

type BrowserRuntimeInputMessage = Extract<
  BrowserClientMessage,
  { type: "input.pointer" | "input.keyboard" | "input.paste" | "input.ime" }
>;

export interface BrowserHumanContextOptions {
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  locale: string;
  extraHTTPHeaders: Record<string, string>;
  timezoneId?: string;
  colorScheme: "light";
  serviceWorkers: "allow";
}

export function readBrowserHumanContextOptions(env: NodeJS.ProcessEnv = process.env): BrowserHumanContextOptions {
  const width = boundedInt(env.BROWSER_VIEWPORT_WIDTH, DEFAULT_BROWSER_VIEWPORT_WIDTH, 800, 3840);
  const height = boundedInt(env.BROWSER_VIEWPORT_HEIGHT, DEFAULT_BROWSER_VIEWPORT_HEIGHT, 600, 2160);
  const locale = safeLocale(env.BROWSER_LOCALE ?? DEFAULT_BROWSER_LOCALE);
  const language = locale.split("-")[0] ?? "en";
  const timezoneId = safeTimezone(env.BROWSER_TIMEZONE_ID);
  return {
    viewport: { width, height },
    screen: { width, height },
    locale,
    extraHTTPHeaders: {
      "Accept-Language": `${locale},${language};q=0.9`,
    },
    ...(timezoneId ? { timezoneId } : {}),
    colorScheme: "light",
    serviceWorkers: "allow",
  };
}

export function browserAutomationDefaultArgs(): string[] {
  return ["--enable-automation"];
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function safeLocale(raw: string): string {
  return /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(raw) ? raw : DEFAULT_BROWSER_LOCALE;
}

function safeTimezone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return /^[A-Za-z_]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?$/.test(raw) ? raw : undefined;
}

export interface BrowserRuntimeServiceOptions {
  launcher: (opts?: { headless?: boolean; userDataDir?: string; args?: string[] }) => Promise<BrowserLike>;
  profileRoot: string;
  defaultProfile?: string;
  headless?: boolean;
  resolveHostname?: ResolveHostname;
  limits?: {
    maxSessions?: number;
    maxTabs?: number;
    maxStreams?: number;
    maxDownloads?: number;
    maxMemoryBytes?: number;
    maxProfileBytes?: number;
    idleMs?: number;
  };
}

export class BrowserRuntimeService {
  private readonly manager: SessionManager;
  private readonly resolveHostname: ResolveHostname | undefined;
  private readonly maxSessions: number;
  private readonly maxTabs: number;
  private readonly maxStreams: number;
  private readonly maxDownloads: number;
  private readonly maxMemoryBytes: number;
  private readonly maxProfileBytes: number;
  private readonly idleMs: number;
  private readonly tabs = new Map<string, BrowserRuntimeTabState>();
  private readonly downloads = new Map<string, BrowserRuntimeDownloadState>();
  private recoverableTabsByProfile = new Map<string, BrowserRuntimeTabState[]>();
  private activeTabId: string | undefined;
  private activePolicy: BrowserNavigationPolicyBinding | undefined;
  private launchHostResolverRules: string[] = [];
  private requestPolicyInstalled = false;
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: BrowserRuntimeServiceOptions) {
    this.resolveHostname = opts.resolveHostname;
    this.maxSessions = opts.limits?.maxSessions ?? 1;
    this.maxTabs = opts.limits?.maxTabs ?? 12;
    this.maxStreams = opts.limits?.maxStreams ?? 3;
    this.maxDownloads = opts.limits?.maxDownloads ?? 100;
    this.maxMemoryBytes = opts.limits?.maxMemoryBytes ?? 512 * 1024 * 1024;
    this.maxProfileBytes = opts.limits?.maxProfileBytes ?? 2 * 1024 * 1024 * 1024;
    this.idleMs = opts.limits?.idleMs ?? 15 * 60 * 1000;
    this.manager = new SessionManager({
      launcher: async (launchOpts) => opts.launcher({
        ...launchOpts,
        args: [
          ...chromiumBrowserLaunchArgs(),
          `--window-size=${readBrowserHumanContextOptions().viewport.width},${readBrowserHumanContextOptions().viewport.height}`,
          ...hostResolverLaunchArgs(this.launchHostResolverRules),
        ],
      }),
      profileRoot: opts.profileRoot,
      defaultProfile: opts.defaultProfile,
      headless: opts.headless ?? true,
      idleTimeoutMs: this.idleMs,
    });
  }

  async open(opts: {
    profile?: string;
    deviceId?: string;
    sessionId?: string;
    navigationPolicy?: BrowserNavigationPolicyBinding;
  }): Promise<BrowserRuntimeSessionState> {
    const active = this.manager.getActive();
    if (!active) {
      this.assertOwnerLimits({ sessions: 0 });
      this.launchHostResolverRules = opts.navigationPolicy
        ? createChromiumHostResolverRules(opts.navigationPolicy)
        : [];
    }
    const session = await this.manager.launch(opts);
    if (active && active.id !== session.id) {
      this.requestPolicyInstalled = false;
    }
    const profile = session.profile ?? "default";
    const recoverableTabs = this.recoverableTabsByProfile.get(profile) ?? [];
    if (this.tabs.size === 0 && recoverableTabs.length > 0) {
      for (const tab of recoverableTabs) {
        this.tabs.set(tab.id, { ...tab });
      }
      this.activeTabId = recoverableTabs[0]?.id;
      this.recoverableTabsByProfile.delete(profile);
    }
    return {
      id: session.id,
      profile: session.profile ?? "default",
      profilePath: session.profilePath,
      currentUrl: session.page.url(),
      lastActivity: new Date(session.lastActivity).toISOString(),
      state: "active",
      tabs: this.listTabs(),
    };
  }

  async prepareNavigation(url: string): Promise<BrowserNavigationPolicyBinding> {
    return await createBrowserNavigationPolicy(url, {
      ...(this.resolveHostname ? { resolveHostname: this.resolveHostname } : {}),
    });
  }

  async navigate(url: string): Promise<BrowserRuntimeSessionState> {
    const policy = await createBrowserNavigationPolicy(url, {
      ...(this.resolveHostname ? { resolveHostname: this.resolveHostname } : {}),
    });
    let session = this.manager.getActive();
    if (!session) {
      throw new Error("browser_session_not_open");
    }
    const nextRules = createChromiumHostResolverRules(policy);
    if (!sameStringList(nextRules, this.launchHostResolverRules)) {
      const { id, profile, lockDeviceId } = session;
      await this.manager.close();
      this.launchHostResolverRules = nextRules;
      session = await this.manager.launch({
        sessionId: id,
        profile,
        ...(lockDeviceId ? { deviceId: lockDeviceId } : {}),
      });
      this.requestPolicyInstalled = false;
    }
    await this.installRequestPolicy(session, policy);
    try {
      await session.page.goto(policy.normalizedUrl, {
        waitUntil: "domcontentloaded",
        timeout: RUNTIME_NAVIGATION_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      console.warn(
        "[matrix-browser] navigation failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    this.manager.touch();
    const activeTabId = this.activeTabId ?? this.tabs.keys().next().value ?? "tab_1";
    const activeTab = this.tabs.get(activeTabId);
    this.upsertRuntimeTab({
      id: activeTabId,
      url: policy.normalizedUrl,
      title: null,
      order: activeTab?.order ?? 0,
    });
    return {
      id: session.id,
      profile: session.profile ?? "default",
      profilePath: session.profilePath,
      currentUrl: session.page.url(),
      lastActivity: new Date(session.lastActivity).toISOString(),
      state: "active",
      tabs: this.listTabs(),
    };
  }

  async navigateSession(sessionId: string, url: string): Promise<BrowserRuntimeSessionState> {
    return await this.enqueueRuntimeOperation(async () => {
      const session = this.manager.getActive();
      if (!session || session.id !== sessionId) {
        throw new Error("browser_session_not_found");
      }
      return await this.navigate(url);
    });
  }

  async captureFrame(sessionId: string): Promise<BrowserRuntimeFrame> {
    return await this.enqueueRuntimeOperation(async () => {
      const session = this.manager.getActive();
      if (!session || session.id !== sessionId) {
        throw new Error("browser_session_not_found");
      }
      const page = await this.ensureLivePage(session);
      const data = await this.capturePageJpeg(page);
      this.manager.touch();
      return {
        sessionId,
        url: page.url(),
        mimeType: "image/jpeg",
        data,
        capturedAt: new Date().toISOString(),
      };
    });
  }

  async applyInput(sessionId: string, message: BrowserRuntimeInputMessage): Promise<void> {
    await this.enqueueRuntimeOperation(async () => {
      const session = this.manager.getActive();
      if (!session || session.id !== sessionId) {
        throw new Error("browser_session_not_found");
      }
      const page = await this.ensureLivePage(session);
      if (message.type === "input.pointer") {
        const { kind, x, y, button, deltaX, deltaY } = message.payload;
        await page.mouse.move?.(x, y);
        if (kind === "down" && button !== "none") {
          await page.mouse.down?.({ button });
        } else if (kind === "up" && button !== "none") {
          await page.mouse.up?.({ button });
        } else if (kind === "wheel") {
          await page.mouse.wheel(deltaX ?? 0, deltaY ?? 0);
        }
      } else if (message.type === "input.keyboard") {
        const { kind, key, text } = message.payload;
        if (kind === "text" && text) {
          await page.keyboard?.insertText?.(text);
        } else if (kind === "keydown") {
          if (text && page.keyboard?.insertText) {
            await page.keyboard.insertText(text);
          } else if (page.keyboard?.press) {
            await page.keyboard.press(key);
          } else {
            await page.keyboard?.down?.(key);
          }
        } else if (kind === "keyup") {
          await page.keyboard?.up?.(key);
        }
      } else if (message.type === "input.paste") {
        await page.keyboard?.insertText?.(message.payload.text);
      } else if (message.type === "input.ime" && message.payload.kind === "compositionend") {
        await page.keyboard?.insertText?.(message.payload.text);
      }
      this.manager.touch();
    });
  }

  createTab(input: { url?: string; title?: string | null } = {}): BrowserRuntimeTabState {
    if (this.tabs.size >= this.maxTabs) {
      throw new Error("browser_tab_limit_reached");
    }
    const tab: BrowserRuntimeTabState = {
      id: `tab_${Date.now()}_${this.tabs.size + 1}`,
      url: input.url ?? "about:blank",
      title: input.title ?? null,
      order: this.tabs.size,
    };
    this.tabs.set(tab.id, tab);
    this.activeTabId = tab.id;
    this.manager.touch();
    return { ...tab };
  }

  createDownload(input: { filename: string; now?: number }): BrowserRuntimeDownloadState {
    this.assertOwnerLimits({ downloads: this.downloads.size });
    const now = new Date(input.now ?? Date.now()).toISOString();
    const download: BrowserRuntimeDownloadState = {
      id: `download_${Date.now()}_${this.downloads.size + 1}`,
      filename: input.filename.slice(0, 180) || "download",
      state: "staged",
      createdAt: now,
      updatedAt: now,
    };
    this.downloads.set(download.id, download);
    this.manager.touch();
    return { ...download };
  }

  completeDownload(downloadId: string, now = Date.now()): BrowserRuntimeDownloadState {
    return this.updateDownload(downloadId, "complete", now);
  }

  failDownload(downloadId: string, now = Date.now()): BrowserRuntimeDownloadState {
    return this.updateDownload(downloadId, "failed", now);
  }

  listDownloads(): BrowserRuntimeDownloadState[] {
    return [...this.downloads.values()].map((download) => ({ ...download }));
  }

  assertOwnerLimits(usage: BrowserRuntimeResourceUsage): void {
    if ((usage.sessions ?? 0) >= this.maxSessions) {
      throw new Error("browser_session_limit_reached");
    }
    if ((usage.streams ?? 0) >= this.maxStreams) {
      throw new Error("browser_stream_limit_reached");
    }
    if ((usage.downloads ?? 0) >= this.maxDownloads) {
      throw new Error("browser_download_limit_reached");
    }
    if ((usage.memoryBytes ?? 0) > this.maxMemoryBytes) {
      throw new Error("browser_memory_limit_reached");
    }
    if ((usage.profileBytes ?? 0) > this.maxProfileBytes) {
      throw new Error("browser_disk_limit_reached");
    }
  }

  listTabs(): BrowserRuntimeTabState[] {
    return [...this.tabs.values()]
      .sort((a, b) => a.order - b.order)
      .map((tab) => ({ ...tab }));
  }

  async hibernateIfIdle(now = Date.now()): Promise<BrowserRuntimeSessionState | null> {
    const session = this.manager.getActive();
    if (!session) return null;
    if (now - session.lastActivity < this.idleMs) return null;
    const recoverableTabs = this.listTabs();
    this.recoverableTabsByProfile.set(session.profile ?? "default", recoverableTabs);
    const state: BrowserRuntimeSessionState = {
      id: session.id,
      profile: session.profile ?? "default",
      profilePath: session.profilePath,
      currentUrl: session.page.url(),
      lastActivity: new Date(session.lastActivity).toISOString(),
      state: "hibernated",
      tabs: recoverableTabs.map((tab) => ({ ...tab })),
    };
    this.tabs.clear();
    this.activeTabId = undefined;
    await this.manager.close();
    this.requestPolicyInstalled = false;
    return state;
  }

  async close(): Promise<void> {
    this.tabs.clear();
    this.downloads.clear();
    this.recoverableTabsByProfile.clear();
    this.activeTabId = undefined;
    this.activePolicy = undefined;
    this.requestPolicyInstalled = false;
    await this.manager.close();
  }

  private async installRequestPolicy(session: { page: PageLike }, policy: BrowserNavigationPolicyBinding): Promise<void> {
    this.activePolicy = policy;
    if (this.requestPolicyInstalled) return;
    const context = session.page.context();
    if (!context.route) return;
    await context.route("**/*", async (route) => {
      const currentPolicy = this.activePolicy;
      if (!currentPolicy) {
        await route.abort("blockedbyclient");
        return;
      }
      try {
        await this.assertOrRefreshRuntimePolicy(route.request().url(), currentPolicy);
        await route.continue();
      } catch (error: unknown) {
        console.warn(
          "[matrix-browser] runtime request blocked:",
          error instanceof Error ? error.message : String(error),
        );
        await route.abort("blockedbyclient");
      }
    });
    this.requestPolicyInstalled = true;
  }

  private async assertOrRefreshRuntimePolicy(rawUrl: string, policy: BrowserNavigationPolicyBinding): Promise<void> {
    const opts = {
      ...(this.resolveHostname ? { resolveHostname: this.resolveHostname } : {}),
    };
    if (Date.now() <= Date.parse(policy.expiresAt)) {
      await assertRuntimeRequestMatchesPolicy(rawUrl, policy, opts);
      return;
    }
    const refreshed = await createBrowserNavigationPolicy(rawUrl, opts);
    if (refreshed.hostname === policy.hostname) {
      this.activePolicy = refreshed;
    }
  }

  private upsertRuntimeTab(tab: BrowserRuntimeTabState): void {
    if (!this.tabs.has(tab.id) && this.tabs.size >= this.maxTabs) {
      throw new Error("browser_tab_limit_reached");
    }
    this.tabs.set(tab.id, { ...tab });
    this.activeTabId = tab.id;
  }

  private updateDownload(
    downloadId: string,
    state: BrowserRuntimeDownloadState["state"],
    now: number,
  ): BrowserRuntimeDownloadState {
    const download = this.downloads.get(downloadId);
    if (!download) {
      throw new Error("browser_download_not_found");
    }
    download.state = state;
    download.updatedAt = new Date(now).toISOString();
    this.manager.touch();
    return { ...download };
  }

  private async ensureLivePage(session: { browser: BrowserLike; page: PageLike }): Promise<PageLike> {
    if (!session.page.isClosed?.()) {
      return session.page;
    }
    for (const context of session.browser.contexts()) {
      const page = context.pages().find((candidate) => !candidate.isClosed?.());
      if (page) {
        this.manager.setActivePage(page);
        return page;
      }
      const nextPage = await context.newPage();
      this.manager.setActivePage(nextPage);
      return nextPage;
    }
    const page = await session.browser.newPage();
    this.manager.setActivePage(page);
    return page;
  }

  private async capturePageJpeg(page: PageLike): Promise<string> {
    const context = page.context();
    if (context.newCDPSession) {
      const client = await context.newCDPSession(page);
      const result = await client.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 60,
        fromSurface: true,
      });
      const data = (result as { data?: unknown }).data;
      if (typeof data === "string" && data.length > 0) {
        return data;
      }
    }
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 60,
      fullPage: false,
      timeout: RUNTIME_FRAME_CAPTURE_TIMEOUT_MS,
    });
    return buffer.toString("base64");
  }

  private async enqueueRuntimeOperation<T>(run: () => Promise<T>): Promise<T> {
    const ready = this.operationQueue.catch((error: unknown) => {
      console.warn(
        "[matrix-browser] Previous runtime operation failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
    const current = ready.then(run);
    this.operationQueue = current.catch(() => undefined);
    return await current;
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function hostResolverLaunchArgs(rules: string[]): string[] {
  return rules.length > 0 ? [`--host-resolver-rules=${rules.join(",")}`] : [];
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function startBrowserRuntimeDaemon(opts: { port?: number } = {}) {
  const port = opts.port ?? Number(process.env.BROWSER_RUNTIME_PORT ?? 4011);
  const runtimePromise = createDefaultBrowserRuntimeService().catch((error: unknown) => {
    console.error("[matrix-browser] runtime initialization failed:", error instanceof Error ? error.message : String(error));
    throw error;
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleBrowserRuntimeRequest(req, res, runtimePromise).catch((error: unknown) => {
      console.error("[matrix-browser] request failed:", error instanceof Error ? error.message : String(error));
      writeJson(res, 500, { error: "internal_error" });
    });
  });
  server.listen(port, "127.0.0.1", () => {
    console.info(`[matrix-browser] runtime listening on 127.0.0.1:${port}`);
  });
  return server;
}

async function handleBrowserRuntimeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtimePromise: Promise<BrowserRuntimeService>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, {
      ok: true,
      passwordStore: chromiumBrowserLaunchArgs().includes("--password-store=basic"),
      sandbox: !chromiumBrowserLaunchArgs().includes("--no-sandbox"),
    });
    return;
  }
  const runtime = await runtimePromise;
  if (req.method === "POST" && url.pathname === "/sessions") {
    const body = await readJsonBody(req);
    const profileName = typeof body.profileName === "string" ? body.profileName : "default";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : undefined;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const targetUrl = typeof body.targetUrl === "string" ? body.targetUrl : undefined;
    const navigationPolicy = targetUrl && targetUrl !== "about:blank"
      ? await runtime.prepareNavigation(targetUrl)
      : undefined;
    let state = await runtime.open({
      profile: profileName,
      deviceId,
      sessionId,
      ...(navigationPolicy ? { navigationPolicy } : {}),
    });
    if (targetUrl && targetUrl !== "about:blank") {
      state = await runtime.navigate(targetUrl);
    }
    writeJson(res, 200, { session: state });
    return;
  }
  const navigateMatch = url.pathname.match(/^\/sessions\/([^/]+)\/navigate$/);
  if (req.method === "POST" && navigateMatch) {
    const body = await readJsonBody(req);
    if (typeof body.targetUrl !== "string") {
      writeJson(res, 400, { error: "validation_error" });
      return;
    }
    writeJson(res, 200, { session: await runtime.navigateSession(navigateMatch[1] ?? "", body.targetUrl) });
    return;
  }
  const frameMatch = url.pathname.match(/^\/sessions\/([^/]+)\/frame$/);
  if (req.method === "GET" && frameMatch) {
    writeJson(res, 200, { frame: await runtime.captureFrame(frameMatch[1] ?? "") });
    return;
  }
  const inputMatch = url.pathname.match(/^\/sessions\/([^/]+)\/input$/);
  if (req.method === "POST" && inputMatch) {
    const body = await readJsonBody(req);
    const message = parseBrowserClientMessage(body);
    if (
      message.type !== "input.pointer" &&
      message.type !== "input.keyboard" &&
      message.type !== "input.paste" &&
      message.type !== "input.ime"
    ) {
      writeJson(res, 400, { error: "validation_error" });
      return;
    }
    await runtime.applyInput(inputMatch[1] ?? "", message);
    writeJson(res, 200, { ok: true });
    return;
  }
  writeJson(res, 404, { error: "not_found" });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 16 * 1024) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function createDefaultBrowserRuntimeService(): Promise<BrowserRuntimeService> {
  process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY ??= "1";
  const playwright = await import("playwright");
  const humanContext = readBrowserHumanContextOptions();
  return new BrowserRuntimeService({
    profileRoot: process.env.BROWSER_PROFILE_ROOT ?? "/var/lib/matrix-browser/profiles",
    defaultProfile: "default",
    headless: process.env.BROWSER_HEADLESS !== "false",
    launcher: async (launchOpts) => {
      const args = launchOpts?.args ?? chromiumBrowserLaunchArgs();
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH;
      if (launchOpts?.userDataDir) {
        const context = await playwright.chromium.launchPersistentContext(launchOpts.userDataDir, {
          headless: launchOpts.headless ?? true,
          args,
          ignoreDefaultArgs: browserAutomationDefaultArgs(),
          ...humanContext,
          ...(executablePath ? { executablePath } : {}),
        });
        return {
          newPage: () => context.newPage(),
          close: () => context.close(),
          contexts: () => [context],
        } as BrowserLike;
      }
      return await playwright.chromium.launch({
        headless: launchOpts?.headless ?? true,
        args,
        ignoreDefaultArgs: browserAutomationDefaultArgs(),
        ...(executablePath ? { executablePath } : {}),
      }) as unknown as BrowserLike;
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBrowserRuntimeDaemon();
}
