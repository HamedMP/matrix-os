// Orchestrates embedded surfaces in the trusted core (US5). Hosted shell: runs
// the app-session cookie-pair handoff into an isolated partition, then loads
// Canvas. Bridged apps: fetches/caches a short-lived session token, resolves
// the launch URL against the gateway origin, then loads it. Emits embed:state
// so the renderer can show an inline re-auth prompt without ever touching the
// native principal (L1).
import { net, session, type BaseWindow } from "electron";
import { randomUUID } from "node:crypto";
import {
  startPortForward as startMatrixPortForward,
  type PortForwardHandle,
  type StartPortForwardOptions,
} from "@finnaai/matrix/port-forward";
import {
  resolveBrowserAddress,
  resolveRuntimeBrowserNavigation,
} from "../../shared/runtime-browser-url";
import { EmbedManager, type Bounds } from "./embed-manager";
import { LaunchTokenCache } from "./launch-token-cache";
import {
  HOSTED_SHELL_SESSION_REFRESH_RETRY_MS,
  computeHostedShellSessionRefreshDelay,
  handoffWithRetry,
  type CookieJarLike,
  type HandoffResult,
  type ParsedCookie,
} from "./app-session";
import { resolveLaunchUrl } from "./origin-policy";
import { createWebContentsView } from "./web-contents-view";
import type { NativeAppBridge } from "./native-app-bridge";

export type EmbedState = "loading" | "ready" | "auth-required" | "failed";

interface EmbedServiceDeps {
  getWindow: () => BaseWindow | null;
  getGatewayOrigin: () => string;
  getToken: () => string | null;
  emitState: (embedId: string, state: EmbedState) => void;
  appBridge?: NativeAppBridge;
  appPreloadPath?: string;
  startPortForward?: (options: StartPortForwardOptions) => Promise<PortForwardHandle>;
}

interface OpenRequest {
  kind: "hosted-shell" | "code-editor" | "app" | "browser";
  slug?: string;
  appIdentity?: string;
  url?: string;
  bounds: Bounds;
  active?: boolean;
}

interface OpenResult {
  embedId: string;
  state: EmbedState;
}

const MAX_PENDING_HOSTED_SHELLS = 12;
const MAX_PENDING_APPS = 12;
const MAX_PENDING_CODE_EDITORS = 12;
const MAX_PENDING_BROWSERS = 12;
const HOSTED_SHELL_PARTITION = "persist:hosted-shell";
const CODE_EDITOR_PARTITION = "persist:code-editor";
const CODE_EDITOR_ORIGIN = "https://code.matrix-os.com";

interface PendingAppEmbed {
  slug: string;
  appIdentity: string;
  bounds: Bounds;
}

export class EmbedService {
  private readonly manager: EmbedManager;
  private readonly tokenCache = new LaunchTokenCache();
  private readonly deps: EmbedServiceDeps;
  private readonly pendingHostedShells = new Map<string, Bounds>();
  private readonly pendingApps = new Map<string, PendingAppEmbed>();
  private readonly pendingCodeEditors = new Map<string, Bounds>();
  private readonly pendingActive = new Map<string, boolean>();
  private readonly hostedShellIds = new Set<string>();
  private readonly codeEditorIds = new Set<string>();
  private readonly pendingBrowsers = new Set<string>();
  private readonly browserForwards = new Map<string, PortForwardHandle>();
  private hostedShellRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private hostedShellHandoffInFlight: Promise<HandoffResult> | null = null;
  private hostedShellHandoffInFlightGeneration: number | null = null;
  private hostedShellRefreshGatewayOrigin: string | null = null;
  private hostedShellGeneration = 0;
  private browserGeneration = 0;
  private codeEditorGeneration = 0;

  constructor(deps: EmbedServiceDeps) {
    this.deps = deps;
    this.manager = new EmbedManager({
      maxLive: 3,
      getAllowedOrigins: () => [this.deps.getGatewayOrigin()],
      createView: ({
        partition,
        kind,
        slug,
        routeSlug,
        allowedOrigins,
        resolveNavigation,
        onState,
      }) => {
        const window = this.deps.getWindow();
        if (!window) throw new Error("no window for embed");
        const bridge = kind === "app" && slug && this.deps.appBridge && this.deps.appPreloadPath
          ? {
              appIdentity: slug,
              routeSlug: routeSlug ?? slug,
              preloadPath: this.deps.appPreloadPath,
              register: (senderId: number, appIdentity: string, appRouteSlug: string) =>
                this.deps.appBridge!.register(senderId, appIdentity, appRouteSlug),
              unregister: (senderId: number) => this.deps.appBridge!.unregister(senderId),
            }
          : undefined;
        return createWebContentsView({
          window,
          partition,
          allowedOrigins,
          resolveNavigation,
          onState,
          denyPermissions: kind === "code-editor",
          ...(bridge ? { appBridge: bridge } : {}),
        });
      },
    });
  }

  async open(request: OpenRequest): Promise<OpenResult> {
    const gatewayOrigin = this.deps.getGatewayOrigin();
    if (request.kind === "hosted-shell") {
      return this.openHostedShell(gatewayOrigin, request.bounds, request.active ?? true);
    }
    if (request.kind === "code-editor") {
      return this.openCodeEditor(gatewayOrigin, request.bounds, request.active ?? true);
    }
    if (request.kind === "browser") {
      return this.openRuntimeBrowser(
        gatewayOrigin,
        request.url ?? "",
        request.bounds,
        request.active ?? true,
      );
    }
    return this.openApp(
      gatewayOrigin,
      request.slug ?? "",
      request.appIdentity ?? request.slug ?? "",
      request.bounds,
      request.active ?? true,
    );
  }

  setBounds(embedId: string, bounds: Bounds): boolean {
    return this.manager.setBounds(embedId, bounds);
  }

  setScale(embedId: string, factor: number): boolean {
    return this.manager.setScale(embedId, factor);
  }

  setActive(embedId: string, active: boolean): boolean {
    const pending = this.pendingHostedShells.has(embedId)
      || this.pendingCodeEditors.has(embedId)
      || this.pendingApps.has(embedId);
    if (pending) {
      this.pendingActive.set(embedId, active);
    }
    if (active && this.hostedShellIds.has(embedId)) {
      this.scheduleHostedShellSessionRefresh(this.deps.getGatewayOrigin());
    }
    return this.manager.setActive(embedId, active) || pending;
  }

  suspendAll(): boolean {
    for (const embedId of this.pendingHostedShells.keys()) {
      this.pendingActive.set(embedId, false);
    }
    for (const embedId of this.pendingApps.keys()) {
      this.pendingActive.set(embedId, false);
    }
    for (const embedId of this.pendingCodeEditors.keys()) {
      this.pendingActive.set(embedId, false);
    }
    return this.manager.suspendAll();
  }

  async reload(embedId: string): Promise<boolean> {
    if (this.hostedShellIds.has(embedId)) {
      const generation = this.hostedShellGeneration;
      const refreshed = await this.refreshHostedShellSession(this.deps.getGatewayOrigin());
      if (!refreshed.ok) return false;
      if (generation !== this.hostedShellGeneration || !this.hostedShellIds.has(embedId)) {
        return false;
      }
    }
    if (this.codeEditorIds.has(embedId)) {
      const generation = this.codeEditorGeneration;
      const handoff = await this.runCodeEditorHandoff(this.deps.getGatewayOrigin());
      if (!handoff.ok) return false;
      if (generation !== this.codeEditorGeneration || !this.codeEditorIds.has(embedId)) return false;
    }
    return this.manager.reload(embedId);
  }

  close(embedId: string): boolean {
    const wasPending = this.pendingHostedShells.delete(embedId);
    const wasPendingApp = this.pendingApps.delete(embedId);
    const wasPendingCodeEditor = this.pendingCodeEditors.delete(embedId);
    const wasPendingBrowser = this.pendingBrowsers.delete(embedId);
    const browserForward = this.browserForwards.get(embedId);
    this.pendingActive.delete(embedId);
    const wasHostedShell = this.hostedShellIds.delete(embedId);
    const wasCodeEditor = this.codeEditorIds.delete(embedId);
    if (wasHostedShell && this.hostedShellIds.size === 0) {
      this.hostedShellGeneration += 1;
      this.clearHostedShellRefreshTimer();
    }
    const closed = this.manager.close(embedId);
    if (!closed && browserForward) this.disposeBrowserForward(embedId, browserForward);
    return closed || wasPending || wasPendingApp || wasPendingCodeEditor || wasCodeEditor
      || wasPendingBrowser || Boolean(browserForward);
  }

  closeAll(): void {
    this.hostedShellGeneration += 1;
    this.browserGeneration += 1;
    this.codeEditorGeneration += 1;
    this.pendingHostedShells.clear();
    this.pendingApps.clear();
    this.pendingCodeEditors.clear();
    this.pendingBrowsers.clear();
    this.pendingActive.clear();
    this.hostedShellIds.clear();
    this.codeEditorIds.clear();
    this.clearHostedShellRefreshTimer();
    this.tokenCache.clear();
    this.manager.closeAll();
    for (const [embedId, forward] of this.browserForwards) {
      this.disposeBrowserForward(embedId, forward);
    }
    this.deps.appBridge?.clear();
  }

  private async openCodeEditor(
    gatewayOrigin: string,
    bounds: Bounds,
    active: boolean,
  ): Promise<OpenResult> {
    const embedId = randomUUID();
    if (this.pendingCodeEditors.size >= MAX_PENDING_CODE_EDITORS) {
      return { embedId, state: "failed" };
    }
    const generation = this.codeEditorGeneration;
    this.pendingCodeEditors.set(embedId, bounds);
    this.pendingActive.set(embedId, active);
    const handoff = await this.runCodeEditorHandoff(gatewayOrigin);
    if (
      generation !== this.codeEditorGeneration
      || !this.pendingCodeEditors.has(embedId)
    ) {
      return { embedId, state: "failed" };
    }
    if (!handoff.ok) return { embedId, state: "auth-required" };
    try {
      this.attachCodeEditor(bounds, embedId, this.pendingActive.get(embedId) ?? true);
    } catch (err: unknown) {
      this.pendingCodeEditors.delete(embedId);
      this.pendingActive.delete(embedId);
      console.warn(
        "[embed-service] code editor open failed:",
        err instanceof Error ? err.message : String(err),
      );
      return { embedId, state: "failed" };
    }
    this.pendingCodeEditors.delete(embedId);
    this.pendingActive.delete(embedId);
    this.codeEditorIds.add(embedId);
    return { embedId, state: "loading" };
  }

  private attachCodeEditor(bounds: Bounds, embedId: string, active: boolean): void {
    this.manager.open("code-editor", null, bounds, `${CODE_EDITOR_ORIGIN}/`, {
      id: embedId,
      active,
      allowedOrigins: [CODE_EDITOR_ORIGIN],
      resolveNavigation: (rawUrl) => {
        try {
          const url = new URL(rawUrl);
          return url.origin === CODE_EDITOR_ORIGIN
            ? { disposition: "rewrite" as const, url: url.toString() }
            : { disposition: "external" as const };
        } catch {
          return { disposition: "block" as const };
        }
      },
      onState: (state) => this.deps.emitState(embedId, state),
    });
  }

  private async runCodeEditorHandoff(gatewayOrigin: string): Promise<HandoffResult> {
    return handoffWithRetry(
      {
        gatewayOrigin,
        cookieOrigin: CODE_EDITOR_ORIGIN,
        cookieJar: this.cookieJarFor(CODE_EDITOR_PARTITION),
        request: (url, init) => this.gatewayRequest(url, init),
      },
      "/",
    );
  }

  private async openRuntimeBrowser(
    gatewayOrigin: string,
    rawUrl: string,
    bounds: Bounds,
    active: boolean,
  ): Promise<OpenResult> {
    const embedId = randomUUID();
    const resolved = resolveBrowserAddress(rawUrl);
    const token = this.deps.getToken();
    if (resolved?.disposition !== "runtime" || !token) {
      return { embedId, state: token ? "failed" : "auth-required" };
    }
    if (this.pendingBrowsers.size >= MAX_PENDING_BROWSERS) {
      return { embedId, state: "failed" };
    }

    const generation = this.browserGeneration;
    this.pendingBrowsers.add(embedId);
    const startPortForward = this.deps.startPortForward ?? startMatrixPortForward;
    let forward: PortForwardHandle;
    try {
      forward = await startPortForward({
        gatewayUrl: gatewayOrigin,
        token,
        localHost: "127.0.0.1",
        localPort: 0,
        remoteHost: resolved.remoteHost,
        remotePort: resolved.remotePort,
      });
    } catch (err: unknown) {
      this.pendingBrowsers.delete(embedId);
      console.warn(
        "[embed-service] runtime browser tunnel failed:",
        err instanceof Error ? err.message : String(err),
      );
      return { embedId, state: "failed" };
    }

    const stillPending = this.pendingBrowsers.delete(embedId);
    if (generation !== this.browserGeneration || !stillPending) {
      void forward.close().catch((err: unknown) => {
        console.warn(
          "[embed-service] stale runtime browser tunnel cleanup failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
      return { embedId, state: "failed" };
    }

    const localUrl = new URL(resolved.url);
    localUrl.hostname = "127.0.0.1";
    localUrl.port = String(forward.localPort);
    const allowedOrigins = [localUrl.origin];
    this.browserForwards.set(embedId, forward);
    const disposeForward = () => this.disposeBrowserForward(embedId, forward);
    void forward.closed.then(
      () => this.handleBrowserForwardClosed(embedId, forward),
      (err: unknown) => this.handleBrowserForwardClosed(embedId, forward, err),
    );
    try {
      this.manager.open("browser", null, bounds, localUrl.toString(), {
        id: embedId,
        active,
        allowedOrigins,
        resolveNavigation: (url) => resolveRuntimeBrowserNavigation(
          url,
          resolved.remotePort,
          localUrl.origin,
        ),
        onDispose: disposeForward,
        onState: (state) => this.deps.emitState(embedId, state),
      });
    } catch (err: unknown) {
      disposeForward();
      console.warn(
        "[embed-service] runtime browser open failed:",
        err instanceof Error ? err.message : String(err),
      );
      return { embedId, state: "failed" };
    }
    return { embedId, state: "loading" };
  }

  private disposeBrowserForward(embedId: string, forward: PortForwardHandle): void {
    if (this.browserForwards.get(embedId) !== forward) return;
    this.browserForwards.delete(embedId);
    void forward.close().catch((err: unknown) => {
      console.warn(
        "[embed-service] runtime browser tunnel cleanup failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  private handleBrowserForwardClosed(
    embedId: string,
    forward: PortForwardHandle,
    err?: unknown,
  ): void {
    if (this.browserForwards.get(embedId) !== forward) return;
    this.browserForwards.delete(embedId);
    this.deps.emitState(embedId, "failed");
    this.manager.close(embedId);
    if (err === undefined) return;
    console.warn(
      "[embed-service] runtime browser tunnel close monitoring failed:",
      err instanceof Error ? err.message : String(err),
    );
    void forward.close().catch((closeErr: unknown) => {
      console.warn(
        "[embed-service] failed Browser tunnel final cleanup:",
        closeErr instanceof Error ? closeErr.message : String(closeErr),
      );
    });
  }

  async retryAuth(embedId: string): Promise<boolean> {
    // The renderer asks to retry after an inline sign-in; re-run the handoff
    // and resume the embed. The native principal is never altered here.
    if (this.pendingHostedShells.has(embedId)) {
      const bounds = this.pendingHostedShells.get(embedId)!;
      const gatewayOrigin = this.deps.getGatewayOrigin();
      const handoff = await this.runHostedShellHandoff(gatewayOrigin);
      if (!handoff.ok) {
        if (this.pendingHostedShells.has(embedId)) {
          this.deps.emitState(embedId, "auth-required");
        }
        return false;
      }
      if (!this.pendingHostedShells.has(embedId)) return false;
      const active = this.pendingActive.get(embedId) ?? true;
      this.attachHostedShellEmbed(gatewayOrigin, bounds, embedId, active);
      this.pendingHostedShells.delete(embedId);
      this.pendingActive.delete(embedId);
      this.hostedShellIds.add(embedId);
      this.scheduleHostedShellSessionRefresh(gatewayOrigin);
      this.deps.emitState(embedId, "loading");
      return true;
    }
    if (this.pendingCodeEditors.has(embedId)) {
      const bounds = this.pendingCodeEditors.get(embedId)!;
      const generation = this.codeEditorGeneration;
      const handoff = await this.runCodeEditorHandoff(this.deps.getGatewayOrigin());
      if (
        generation !== this.codeEditorGeneration
        || !this.pendingCodeEditors.has(embedId)
      ) return false;
      if (!handoff.ok) {
        this.deps.emitState(embedId, "auth-required");
        return false;
      }
      try {
        this.attachCodeEditor(bounds, embedId, this.pendingActive.get(embedId) ?? true);
      } catch (err: unknown) {
        this.pendingCodeEditors.delete(embedId);
        this.pendingActive.delete(embedId);
        console.warn(
          "[embed-service] code editor retry failed:",
          err instanceof Error ? err.message : String(err),
        );
        this.deps.emitState(embedId, "failed");
        return false;
      }
      this.pendingCodeEditors.delete(embedId);
      this.pendingActive.delete(embedId);
      this.codeEditorIds.add(embedId);
      this.deps.emitState(embedId, "loading");
      return true;
    }
    if (this.pendingApps.has(embedId)) {
      const pending = this.pendingApps.get(embedId)!;
      const opened = await this.createAppEmbed(
        this.deps.getGatewayOrigin(),
        pending.slug,
        pending.appIdentity,
        pending.bounds,
        embedId,
        this.pendingActive.get(embedId) ?? true,
        () => this.pendingApps.has(embedId),
      );
      if (!opened) {
        if (this.pendingApps.has(embedId)) this.deps.emitState(embedId, "auth-required");
        return false;
      }
      this.pendingApps.delete(embedId);
      this.pendingActive.delete(embedId);
      this.deps.emitState(embedId, "loading");
      return true;
    }
    if (!this.manager.has(embedId)) return false;
    if (this.hostedShellIds.has(embedId)) {
      const handoff = await this.runHostedShellHandoff(this.deps.getGatewayOrigin());
      if (!this.manager.has(embedId) || !this.hostedShellIds.has(embedId)) return false;
      if (!handoff.ok) {
        this.deps.emitState(embedId, "auth-required");
        return false;
      }
      this.scheduleHostedShellSessionRefresh(this.deps.getGatewayOrigin());
      return this.manager.reload(embedId);
    }
    if (this.codeEditorIds.has(embedId)) {
      const generation = this.codeEditorGeneration;
      const handoff = await this.runCodeEditorHandoff(this.deps.getGatewayOrigin());
      if (
        generation !== this.codeEditorGeneration
        || !this.codeEditorIds.has(embedId)
      ) return false;
      if (!handoff.ok) {
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
        return cookies.map((c) => ({
          name: c.name,
          domain: c.domain,
          path: c.path,
          ...(typeof c.expirationDate === "number" ? { expires: c.expirationDate * 1000 } : {}),
        }));
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
    const generation = this.hostedShellGeneration;
    const opened = await this.createHostedShellEmbed(gatewayOrigin, bounds, embedId, active);
    if (generation !== this.hostedShellGeneration) {
      return { embedId, state: "failed" };
    }
    if (!opened) {
      this.rememberPendingHostedShell(embedId, bounds, active);
      return { embedId, state: "auth-required" };
    }
    this.hostedShellIds.add(embedId);
    this.scheduleHostedShellSessionRefresh(gatewayOrigin);
    return { embedId, state: "loading" };
  }

  private rememberPendingHostedShell(embedId: string, bounds: Bounds, active: boolean): void {
    this.pendingHostedShells.set(embedId, bounds);
    this.pendingActive.set(embedId, active);
    while (this.pendingHostedShells.size > MAX_PENDING_HOSTED_SHELLS) {
      const oldest = this.pendingHostedShells.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingHostedShells.delete(oldest);
      this.pendingActive.delete(oldest);
    }
  }

  private async createHostedShellEmbed(
    gatewayOrigin: string,
    bounds: Bounds,
    embedId: string,
    active: boolean,
  ): Promise<boolean> {
    const handoff = await this.runHostedShellHandoff(gatewayOrigin);
    if (!handoff.ok) return false;
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

  private async performHostedShellHandoff(gatewayOrigin: string): Promise<HandoffResult> {
    return handoffWithRetry(
      {
        gatewayOrigin,
        cookieJar: this.cookieJarFor(HOSTED_SHELL_PARTITION),
        request: (url, init) => this.gatewayRequest(url, init),
      },
      "/",
    );
  }

  private async runHostedShellHandoff(gatewayOrigin: string): Promise<HandoffResult> {
    const generation = this.hostedShellGeneration;
    if (
      this.hostedShellHandoffInFlight &&
      this.hostedShellHandoffInFlightGeneration === generation
    ) {
      return this.hostedShellHandoffInFlight;
    }
    const priorHandoff = this.hostedShellHandoffInFlight;
    const priorGeneration = this.hostedShellHandoffInFlightGeneration;
    let handoff!: Promise<HandoffResult>;
    handoff = (async () => {
      try {
        if (priorHandoff && priorGeneration !== generation) {
          try {
            await priorHandoff;
          } catch (err: unknown) {
            console.warn(
              "[embed-service] prior hosted-shell handoff failed during runtime reset:",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        if (generation !== this.hostedShellGeneration) {
          return { ok: false, reason: "unavailable" };
        }
        const result = await this.performHostedShellHandoff(gatewayOrigin);
        if (generation !== this.hostedShellGeneration) {
          return { ok: false, reason: "unavailable" };
        }
        return result;
      } finally {
        if (this.hostedShellHandoffInFlight === handoff) {
          this.hostedShellHandoffInFlight = null;
          this.hostedShellHandoffInFlightGeneration = null;
        }
      }
    })();
    this.hostedShellHandoffInFlight = handoff;
    this.hostedShellHandoffInFlightGeneration = generation;
    return handoff;
  }

  private clearHostedShellRefreshTimer(): void {
    if (this.hostedShellRefreshTimer) clearTimeout(this.hostedShellRefreshTimer);
    this.hostedShellRefreshTimer = null;
    this.hostedShellRefreshGatewayOrigin = null;
  }

  private scheduleHostedShellSessionRefresh(gatewayOrigin: string, delayMs?: number): void {
    const generation = this.hostedShellGeneration;
    this.hostedShellRefreshGatewayOrigin = gatewayOrigin;
    if (this.hostedShellRefreshTimer) clearTimeout(this.hostedShellRefreshTimer);
    this.hostedShellRefreshTimer = null;
    if (this.hostedShellIds.size === 0) return;

    if (delayMs !== undefined) {
      this.armHostedShellRefreshTimer(gatewayOrigin, delayMs, generation);
      return;
    }

    void this.readHostedShellRefreshDelay()
      .then((delay) => {
        if (
          generation === this.hostedShellGeneration &&
          this.hostedShellRefreshGatewayOrigin === gatewayOrigin
        ) {
          this.armHostedShellRefreshTimer(gatewayOrigin, delay, generation);
        }
      })
      .catch((err: unknown) => {
        console.warn(
          "[embed-service] unable to read hosted-shell session expiry:",
          err instanceof Error ? err.message : String(err),
        );
        if (
          generation === this.hostedShellGeneration &&
          this.hostedShellRefreshGatewayOrigin === gatewayOrigin
        ) {
          this.armHostedShellRefreshTimer(
            gatewayOrigin,
            HOSTED_SHELL_SESSION_REFRESH_RETRY_MS,
            generation,
          );
        }
      });
  }

  private armHostedShellRefreshTimer(
    gatewayOrigin: string,
    delayMs: number,
    generation = this.hostedShellGeneration,
  ): void {
    if (generation !== this.hostedShellGeneration || this.hostedShellIds.size === 0) return;
    if (this.hostedShellRefreshTimer) clearTimeout(this.hostedShellRefreshTimer);
    this.hostedShellRefreshTimer = setTimeout(() => {
      if (generation === this.hostedShellGeneration) {
        void this.refreshHostedShellSession(gatewayOrigin);
      }
    }, Math.max(0, delayMs));
  }

  private async readHostedShellRefreshDelay(): Promise<number> {
    const cookies = await this.cookieJarFor(HOSTED_SHELL_PARTITION).get({});
    return computeHostedShellSessionRefreshDelay(cookies);
  }

  private emitHostedShellAuthRequired(): void {
    for (const embedId of this.hostedShellIds) {
      this.deps.emitState(embedId, "auth-required");
    }
  }

  private async refreshHostedShellSession(gatewayOrigin: string): Promise<HandoffResult> {
    const generation = this.hostedShellGeneration;
    if (this.hostedShellIds.size === 0) {
      this.clearHostedShellRefreshTimer();
      return { ok: false, reason: "unavailable" };
    }
    const result = await this.runHostedShellHandoff(gatewayOrigin);
    if (generation !== this.hostedShellGeneration || this.hostedShellIds.size === 0) {
      return { ok: false, reason: "unavailable" };
    }
    if (result.ok) {
      this.scheduleHostedShellSessionRefresh(gatewayOrigin);
    } else if (result.reason === "unavailable") {
      this.scheduleHostedShellSessionRefresh(gatewayOrigin, HOSTED_SHELL_SESSION_REFRESH_RETRY_MS);
    } else {
      this.clearHostedShellRefreshTimer();
      this.emitHostedShellAuthRequired();
    }
    return result;
  }

  private async openApp(
    gatewayOrigin: string,
    slug: string,
    appIdentity: string,
    bounds: Bounds,
    active: boolean,
  ): Promise<OpenResult> {
    const embedId = randomUUID();
    const opened = await this.createAppEmbed(gatewayOrigin, slug, appIdentity, bounds, embedId, active);
    if (!opened) {
      this.rememberPendingApp(embedId, { slug, appIdentity, bounds }, active);
      return { embedId, state: "auth-required" };
    }
    return { embedId, state: "loading" };
  }

  private rememberPendingApp(embedId: string, pending: PendingAppEmbed, active: boolean): void {
    this.pendingApps.set(embedId, pending);
    this.pendingActive.set(embedId, active);
    while (this.pendingApps.size > MAX_PENDING_APPS) {
      const oldest = this.pendingApps.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingApps.delete(oldest);
      this.pendingActive.delete(oldest);
    }
  }

  private async createAppEmbed(
    gatewayOrigin: string,
    slug: string,
    appIdentity: string,
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
    this.manager.open("app", appIdentity, bounds, resolved, {
      id: embedId,
      active,
      routeSlug: slug,
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
