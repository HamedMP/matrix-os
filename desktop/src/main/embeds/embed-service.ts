// Orchestrates embedded surfaces in the trusted core (US5). Hosted shell: runs
// the app-session cookie-pair handoff into an isolated partition, then loads
// Canvas. Bridged apps: fetches/caches a short-lived session token, resolves
// the launch URL against the gateway origin, then loads it. Emits embed:state
// so the renderer can show an inline re-auth prompt without ever touching the
// native principal (L1).
import { net, session, type BaseWindow } from "electron";
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
}

export class EmbedService {
  private readonly manager: EmbedManager;
  private readonly tokenCache = new LaunchTokenCache();
  private readonly deps: EmbedServiceDeps;

  constructor(deps: EmbedServiceDeps) {
    this.deps = deps;
    this.manager = new EmbedManager({
      maxLive: 3,
      createView: ({ partition }) => {
        const window = this.deps.getWindow();
        if (!window) throw new Error("no window for embed");
        return createWebContentsView({
          window,
          partition,
          allowedOrigins: [this.deps.getGatewayOrigin()],
          onState: () => undefined,
        });
      },
    });
  }

  async open(request: OpenRequest): Promise<string> {
    const gatewayOrigin = this.deps.getGatewayOrigin();
    if (request.kind === "hosted-shell") {
      return this.openHostedShell(gatewayOrigin, request.bounds);
    }
    return this.openApp(gatewayOrigin, request.slug ?? "", request.bounds);
  }

  setBounds(embedId: string, bounds: Bounds): boolean {
    return this.manager.setBounds(embedId, bounds);
  }

  close(embedId: string): boolean {
    return this.manager.close(embedId);
  }

  closeAll(): void {
    this.manager.closeAll();
  }

  async retryAuth(embedId: string): Promise<boolean> {
    // The renderer asks to retry after an inline sign-in; re-run the handoff
    // and resume the embed. The native principal is never altered here.
    if (!this.manager.has(embedId)) return false;
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

  private async openHostedShell(gatewayOrigin: string, bounds: Bounds): Promise<string> {
    const handoff = await handoffWithRetry(
      {
        gatewayOrigin,
        cookieJar: this.cookieJarFor("persist:hosted-shell"),
        request: (url, init) => this.gatewayRequest(url, init),
      },
      "/",
    );
    const url = `${gatewayOrigin}/`;
    const embedId = this.manager.open("hosted-shell", null, bounds, url);
    if (!handoff.ok) {
      this.deps.emitState(embedId, "auth-required");
    }
    return embedId;
  }

  private async openApp(gatewayOrigin: string, slug: string, bounds: Bounds): Promise<string> {
    let cached = this.tokenCache.get(slug);
    if (!cached) {
      const token = await this.fetchLaunchToken(gatewayOrigin, slug);
      if (token) {
        this.tokenCache.set(slug, token);
        cached = token;
      }
    }
    if (!cached) throw new Error("could not obtain app launch token");
    const resolved = resolveLaunchUrl(cached.launchUrl, gatewayOrigin);
    if (!resolved) throw new Error("app launch url failed origin check");
    return this.manager.open("app", slug, bounds, resolved);
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
