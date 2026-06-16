// Orchestrates embedded surfaces in the trusted core (US5). Hosted shell: runs
// the app-session cookie-pair handoff into an isolated partition, then loads
// Canvas. Bridged apps: fetches/caches a short-lived session token, resolves
// the launch URL against the gateway origin, then loads it. Emits embed:state
// so the renderer can show an inline re-auth prompt without ever touching the
// native principal (L1).
import { net, session, type BaseWindow } from "electron";
import { randomUUID } from "node:crypto";
import { EmbedManager, type Bounds } from "./embed-manager";
import { LaunchTokenCache } from "./launch-token-cache";
import { handoffWithRetry, type CookieJarLike, type ParsedCookie } from "./app-session";
import { resolveLaunchUrl } from "./origin-policy";
import { createWebContentsView } from "./web-contents-view";

export type EmbedState = "loading" | "ready" | "auth-required" | "failed";

interface EmbedServiceDeps {
  getWindow: () => BaseWindow | null;
  getGatewayOrigin: () => string;
  getToken: () => string | null;
  emitState: (embedId: string, state: EmbedState) => void;
}

interface OpenRequest {
  kind: "hosted-shell" | "app";
  slug?: string;
  bounds: Bounds;
  active?: boolean;
}

interface OpenResult {
  embedId: string;
  state: EmbedState;
}

const MAX_PENDING_HOSTED_SHELLS = 12;
const MAX_PENDING_APPS = 12;

interface PendingAppEmbed {
  slug: string;
  bounds: Bounds;
}

export class EmbedService {
  private readonly manager: EmbedManager;
  private readonly tokenCache = new LaunchTokenCache();
  private readonly deps: EmbedServiceDeps;
  private readonly pendingHostedShells = new Map<string, Bounds>();
  private readonly pendingApps = new Map<string, PendingAppEmbed>();
  private readonly hostedShellIds = new Set<string>();

  constructor(deps: EmbedServiceDeps) {
    this.deps = deps;
    this.manager = new EmbedManager({
      maxLive: 3,
      getAllowedOrigins: () => [this.deps.getGatewayOrigin()],
      createView: ({ partition, onState }) => {
        const window = this.deps.getWindow();
        if (!window) throw new Error("no window for embed");
        return createWebContentsView({
          window,
          partition,
          allowedOrigins: [this.deps.getGatewayOrigin()],
          onState,
        });
      },
    });
  }

  async open(request: OpenRequest): Promise<OpenResult> {
    const gatewayOrigin = this.deps.getGatewayOrigin();
    if (request.kind === "hosted-shell") {
      return this.openHostedShell(gatewayOrigin, request.bounds, request.active ?? true);
    }
    return this.openApp(gatewayOrigin, request.slug ?? "", request.bounds, request.active ?? true);
  }

  setBounds(embedId: string, bounds: Bounds): boolean {
    return this.manager.setBounds(embedId, bounds);
  }

  setActive(embedId: string, active: boolean): boolean {
    return this.manager.setActive(embedId, active);
  }

  close(embedId: string): boolean {
    const wasPending = this.pendingHostedShells.delete(embedId);
    const wasPendingApp = this.pendingApps.delete(embedId);
    this.hostedShellIds.delete(embedId);
    return this.manager.close(embedId) || wasPending || wasPendingApp;
  }

  closeAll(): void {
    this.pendingHostedShells.clear();
    this.pendingApps.clear();
    this.hostedShellIds.clear();
    this.tokenCache.clear();
    this.manager.closeAll();
  }

  async retryAuth(embedId: string): Promise<boolean> {
    // The renderer asks to retry after an inline sign-in; re-run the handoff
    // and resume the embed. The native principal is never altered here.
    if (this.pendingHostedShells.has(embedId)) {
      const bounds = this.pendingHostedShells.get(embedId)!;
      const gatewayOrigin = this.deps.getGatewayOrigin();
      const handoff = await this.performHostedShellHandoff(gatewayOrigin);
      if (!handoff) {
        if (this.pendingHostedShells.has(embedId)) {
          this.deps.emitState(embedId, "auth-required");
        }
        return false;
      }
      if (!this.pendingHostedShells.has(embedId)) return false;
      this.attachHostedShellEmbed(gatewayOrigin, bounds, embedId);
      this.pendingHostedShells.delete(embedId);
      this.hostedShellIds.add(embedId);
      this.deps.emitState(embedId, "loading");
      return true;
    }
    if (this.pendingApps.has(embedId)) {
      const pending = this.pendingApps.get(embedId)!;
      const opened = await this.createAppEmbed(
        this.deps.getGatewayOrigin(),
        pending.slug,
        pending.bounds,
        embedId,
        true,
        () => this.pendingApps.has(embedId),
      );
      if (!opened) {
        if (this.pendingApps.has(embedId)) this.deps.emitState(embedId, "auth-required");
        return false;
      }
      this.pendingApps.delete(embedId);
      this.deps.emitState(embedId, "loading");
      return true;
    }
    if (!this.manager.has(embedId)) return false;
    if (this.hostedShellIds.has(embedId)) {
      const handoff = await this.performHostedShellHandoff(this.deps.getGatewayOrigin());
      if (!handoff) {
        this.deps.emitState(embedId, "auth-required");
        return false;
      }
      return this.manager.reload(embedId);
    }
    return this.manager.focus(embedId);
  }

  private cookieJarFor(partition: string): CookieJarLike {
    const jar = session.fromPartition(partition).cookies;
    return {
      get: async () => {
        const cookies = await jar.get({});
        return cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path }));
      },
      set: async (cookie: ParsedCookie & { url: string }) => {
        await jar.set({
          url: cookie.url,
          name: cookie.name,
          value: cookie.value,
          ...(cookie.domain ? { domain: cookie.domain } : {}),
          ...(cookie.path ? { path: cookie.path } : {}),
          ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
          ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
          ...(cookie.expires !== undefined ? { expirationDate: cookie.expires / 1000 } : {}),
        });
      },
      remove: async (url: string, name: string) => {
        await jar.remove(url, name);
      },
    };
  }

  private async openHostedShell(gatewayOrigin: string, bounds: Bounds, active: boolean): Promise<OpenResult> {
    const embedId = randomUUID();
    const opened = await this.createHostedShellEmbed(gatewayOrigin, bounds, embedId, active);
    if (!opened) {
      this.rememberPendingHostedShell(embedId, bounds);
      return { embedId, state: "auth-required" };
    }
    this.hostedShellIds.add(embedId);
    return { embedId, state: "loading" };
  }

  private rememberPendingHostedShell(embedId: string, bounds: Bounds): void {
    this.pendingHostedShells.set(embedId, bounds);
    while (this.pendingHostedShells.size > MAX_PENDING_HOSTED_SHELLS) {
      const oldest = this.pendingHostedShells.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingHostedShells.delete(oldest);
    }
  }

  private async createHostedShellEmbed(
    gatewayOrigin: string,
    bounds: Bounds,
    embedId: string,
    active: boolean,
  ): Promise<boolean> {
    const handoff = await this.performHostedShellHandoff(gatewayOrigin);
    if (!handoff) return false;
    this.attachHostedShellEmbed(gatewayOrigin, bounds, embedId, active);
    return true;
  }

  private attachHostedShellEmbed(
    gatewayOrigin: string,
    bounds: Bounds,
    embedId: string,
    active = true,
  ): void {
    const url = `${gatewayOrigin}/`;
    this.manager.open("hosted-shell", null, bounds, url, {
      id: embedId,
      active,
      onState: (state) => this.deps.emitState(embedId, state),
    });
  }

  private async performHostedShellHandoff(gatewayOrigin: string): Promise<boolean> {
    const handoff = await handoffWithRetry(
      {
        gatewayOrigin,
        cookieJar: this.cookieJarFor("persist:hosted-shell"),
        request: (url, init) => this.gatewayRequest(url, init),
      },
      "/",
    );
    return handoff.ok;
  }

  private async openApp(gatewayOrigin: string, slug: string, bounds: Bounds, active: boolean): Promise<OpenResult> {
    const embedId = randomUUID();
    const opened = await this.createAppEmbed(gatewayOrigin, slug, bounds, embedId, active);
    if (!opened) {
      this.rememberPendingApp(embedId, { slug, bounds });
      return { embedId, state: "auth-required" };
    }
    return { embedId, state: "loading" };
  }

  private rememberPendingApp(embedId: string, pending: PendingAppEmbed): void {
    this.pendingApps.set(embedId, pending);
    while (this.pendingApps.size > MAX_PENDING_APPS) {
      const oldest = this.pendingApps.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingApps.delete(oldest);
    }
  }

  private async createAppEmbed(
    gatewayOrigin: string,
    slug: string,
    bounds: Bounds,
    embedId: string,
    active = true,
    shouldAttach: () => boolean = () => true,
  ): Promise<boolean> {
    let cached = this.tokenCache.get(slug);
    if (!cached) {
      const token = await this.fetchLaunchToken(gatewayOrigin, slug);
      if (token) {
        this.tokenCache.set(slug, token);
        cached = token;
      }
    }
    if (!cached) return false;
    if (!shouldAttach()) return false;
    const resolved = resolveLaunchUrl(cached.launchUrl, gatewayOrigin);
    if (!resolved) {
      console.warn("[embed-service] app launch url failed origin check:", cached.launchUrl);
      this.tokenCache.delete(slug);
      return false;
    }
    this.manager.open("app", slug, bounds, resolved, {
      id: embedId,
      active,
      onState: (state) => this.deps.emitState(embedId, state),
    });
    return true;
  }

  private async fetchLaunchToken(
    gatewayOrigin: string,
    slug: string,
  ): Promise<{ launchUrl: string; expiresAt: number } | null> {
    try {
      const response = await this.gatewayRequest(
        `${gatewayOrigin}/api/apps/${encodeURIComponent(slug)}/session-token`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      if (response.status < 200 || response.status >= 300) return null;
      const parsed: unknown = JSON.parse(response.body);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { launchUrl?: unknown }).launchUrl === "string" &&
        typeof (parsed as { expiresAt?: unknown }).expiresAt === "number"
      ) {
        const { launchUrl, expiresAt } = parsed as { launchUrl: string; expiresAt: number };
        return { launchUrl, expiresAt };
      }
      return null;
    } catch (err: unknown) {
      console.warn(
        "[embed-service] launch token fetch failed:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private gatewayRequest(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ status: number; setCookieHeaders: string[]; body: string }> {
    return new Promise((resolve, reject) => {
      const token = this.deps.getToken();
      const request = net.request({ method: init.method, url });
      for (const [key, value] of Object.entries(init.headers)) request.setHeader(key, value);
      if (token) request.setHeader("Authorization", `Bearer ${token}`);
      const timeout = setTimeout(() => {
        request.abort();
        reject(new Error("gateway request timed out"));
      }, 10_000);
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        response.on("end", () => {
          clearTimeout(timeout);
          const rawSetCookie = response.headers["set-cookie"];
          const setCookieHeaders = Array.isArray(rawSetCookie)
            ? rawSetCookie
            : typeof rawSetCookie === "string"
              ? [rawSetCookie]
              : [];
          resolve({
            status: response.statusCode,
            setCookieHeaders,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      request.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      request.end(init.body);
    });
  }
}
