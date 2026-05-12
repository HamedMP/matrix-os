import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createBrowserNavigationPolicy,
  type BrowserNavigationPolicyBinding,
  type ResolveHostname,
} from "./security.js";
import { chromiumBrowserLaunchArgs } from "./media-service.js";
import { SessionManager, type BrowserLike } from "./session-manager.js";

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
  private recoverableTabs: BrowserRuntimeTabState[] = [];
  private activeTabId: string | undefined;

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
        args: chromiumBrowserLaunchArgs(),
      }),
      profileRoot: opts.profileRoot,
      defaultProfile: opts.defaultProfile,
      headless: opts.headless ?? true,
    });
  }

  async open(opts: { profile?: string; deviceId?: string }): Promise<BrowserRuntimeSessionState> {
    const active = this.manager.getActive();
    if (!active) {
      this.assertOwnerLimits({ sessions: 0 });
    }
    const session = await this.manager.launch(opts);
    if (this.tabs.size === 0 && this.recoverableTabs.length > 0) {
      for (const tab of this.recoverableTabs) {
        this.tabs.set(tab.id, { ...tab });
      }
      this.activeTabId = this.recoverableTabs[0]?.id;
      this.recoverableTabs = [];
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
    const session = this.manager.getActive();
    if (!session) {
      throw new Error("browser_session_not_open");
    }
    await session.page.goto(policy.normalizedUrl, { waitUntil: "domcontentloaded" });
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
    if ((usage.streams ?? 0) > this.maxStreams) {
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
    this.recoverableTabs = this.listTabs();
    const state: BrowserRuntimeSessionState = {
      id: session.id,
      profile: session.profile ?? "default",
      profilePath: session.profilePath,
      currentUrl: session.page.url(),
      lastActivity: new Date(session.lastActivity).toISOString(),
      state: "hibernated",
      tabs: this.recoverableTabs.map((tab) => ({ ...tab })),
    };
    this.tabs.clear();
    this.activeTabId = undefined;
    await this.manager.close();
    return state;
  }

  async close(): Promise<void> {
    this.tabs.clear();
    this.downloads.clear();
    this.recoverableTabs = [];
    this.activeTabId = undefined;
    await this.manager.close();
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
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startBrowserRuntimeDaemon(opts: { port?: number } = {}) {
  const port = opts.port ?? Number(process.env.BROWSER_RUNTIME_PORT ?? 4011);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, {
        ok: true,
        passwordStore: chromiumBrowserLaunchArgs().includes("--password-store=basic"),
        sandbox: !chromiumBrowserLaunchArgs().includes("--no-sandbox"),
      });
      return;
    }
    writeJson(res, 404, { error: "not_found" });
  });
  server.listen(port, "127.0.0.1", () => {
    console.info(`[matrix-browser] runtime listening on 127.0.0.1:${port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBrowserRuntimeDaemon();
}
