import { randomBytes } from "node:crypto";
import type { Hono, Context } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { verifyAppSession, type AppSessionPayloadType } from "../app-runtime/app-session.js";
import { hasPlatformAssetAuthorization } from "../app-runtime/platform-asset-authorization.js";
import { createViewerSockets } from "./viewer-sockets.js";
import { serveStaticFileWithin } from "../app-runtime/serve-static.js";
import { VIEWER_BRIDGE_SCRIPT, injectViewerBridge } from "./viewer-bridge.js";
import { SHARED_BROWSER_ACTION_DEADLINE_MS, SHARED_BROWSER_ACTION_MAX_BYTES, SharedBrowserActionSchema, SharedBrowserControlSchema } from "@matrix-os/contracts";
import { SharedBrowserError, type SharedBrowserBroker } from "../shared-browser/broker.js";

const PREFIX = "/apps/browser-lab";
const CONTROL = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), engine: z.enum(["agent-browser", "browser-use"]) }).strict(),
  z.object({ action: z.literal("takeover") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
]);
const PATH = z.string().max(1024).regex(/^[a-zA-Z0-9_./-]*$/).refine((path) =>
  !path.split("/").some((part) => part === "." || part === "..") && !path.startsWith("/"));
const MAX_BODY = 16 * 1024 * 1024;
const SAFE_RESPONSE_HEADERS = ["content-type", "vary"];
const PRODUCT_CONTROL = z.object({ action: z.enum(["restore-chrome", "show-desktop", "open-files", "open-terminal"]) }).strict();
const PRODUCT_SESSION = z.object({ surface: z.enum(["browser", "desktop"]) }).strict();
const PRODUCT_STATUS = z.object({ available: z.boolean(), chrome: z.object({ present: z.boolean(), minimized: z.boolean() }).strict(), humanControlAvailable: z.boolean() }).strict();

export interface BrowserLabOptions {
  enabled: boolean;
  /** Trusted host composition only; never a request-supplied path. */
  productUiPath?: string;
  /** Owner-bound primary production setup composition; native APIs remain enabled-gated. */
  setupOwnerId?: string;
  viewerAuthorization?: string;
  deriveKey: (slug: string) => Buffer;
  isAllowedOrigin: (origin: string) => boolean;
  upgradeWebSocket?: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
  fetcher?: typeof fetch;
  sharedBrowser?: { broker: SharedBrowserBroker; ownerId: string };
}

export function registerBrowserLabRoutes(app: Hono, options: BrowserLabOptions): { close(): void } {
  // Fixed loopback only; never accept an upstream URL, credentials or fixture route.
  const sockets = options.enabled ? createViewerSockets(options.viewerAuthorization) : undefined;
  const tickets = new Map<string, { expiresAt: number; session: AppSessionPayloadType; claim?: number }>();
  let claimGeneration = 0;
  let productClaim: { generation: number; expiresAt: number; pendingUntil: number; connected: boolean } | undefined;
  const sweepTickets = () => {
    for (const [ticket, value] of tickets) if (Date.now() >= value.expiresAt || Date.now() >= value.session.exp * 1000) tickets.delete(ticket);
    if (productClaim && (Date.now() >= productClaim.expiresAt || !productClaim.connected && Date.now() >= productClaim.pendingUntil)) { productClaim = undefined; tickets.clear(); sockets?.closeConnections(); }
  };
  const ticketTimer = options.enabled ? setInterval(sweepTickets, 15_000) : undefined;
  ticketTimer?.unref();
  const fetcher = options.fetcher ?? fetch;
  let closed = false;
  let activeHttp = 0;
  let activeAgent = 0;
  const agentPath = `${PREFIX}/api/agent-action`;
  const agentGrant = (c: Context) => {
    const header = c.req.header("authorization") ?? "";
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return null;
    const binding = options.sharedBrowser?.broker.resolveCapability(header.slice(7));
    return binding ? { token: header.slice(7), binding } : null;
  };
  app.use(`${PREFIX}/*`, async (c, next) => {
    const setupStatic = options.setupOwnerId && (c.req.path === `${PREFIX}/` || c.req.path === `${PREFIX}/index.html` || c.req.path.startsWith(`${PREFIX}/assets/`));
    if ((!options.enabled && !setupStatic) || closed) return c.json({ error: "not_found" }, 404);
    if (c.req.path === agentPath) {
      if (c.req.method !== "POST" || !agentGrant(c)) return c.json({ error: "Unauthorized" }, 401);
      await next(); return;
    }
    // Native app HTML can reference edge-rebased /vm assets outside its root
    // cookie Path. Reuse the ordinary app asset gate; API/viewer/root cannot use it.
    if (hasPlatformAssetAuthorization(c.req.method, c.req.path, "browser-lab", c.req.header("authorization"))) {
      await next(); return;
    }
    if (c.req.path === `${PREFIX}/viewer/websockify`) {
      sweepTickets();
      const query = new URL(c.req.url).searchParams;
      const ticket = query.get("lab_ticket");
      if (ticket && /^[a-f0-9]{48}$/.test(ticket) && query.getAll("lab_ticket").length === 1) {
        const value = tickets.get(ticket);
        tickets.delete(ticket);
        if (value && (value.claim === undefined || productClaim?.generation === value.claim)) { c.set("appSession" as never, value.session as never); c.set("browserLabClaim" as never, value.claim as never); await next(); return; }
      }
      // WebSockets have no cookie after platform forwarding. A dedicated ticket
      // is the sole admission credential and cannot authorize any HTTP operation.
      return c.json({ error: "session_expired" }, 401);
    }
    // Lab always authenticates even when ordinary local app auth is bypassed.
    const cookie = c.req.header("cookie") ?? "";
    if (cookie.length > 8192) return c.json({ error: "session_expired" }, 401);
    const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("matrix_app_session__browser-lab="))?.slice("matrix_app_session__browser-lab=".length);
    const payload = token ? verifyAppSession(options.deriveKey("browser-lab"), token, Math.floor(Date.now() / 1000)) : null;
    if (!payload || payload.slug !== "browser-lab") return c.json({ error: "session_expired" }, 401);
    c.set("appSession" as never, payload as never);
    await next();
  });
  const allowed = (c: Context) => {
    const origin = c.req.header("origin");
    return !origin || options.isAllowedOrigin(origin);
  };
  const unavailable = (c: Context) => c.json({ error: "Browser service unavailable" }, 502);
  async function proxy(c: Context, url: string, body?: string, method?: "GET"): Promise<Response> {
    if (activeHttp >= 16) return c.json({ error: "Browser service busy" }, 503);
    activeHttp++;
    try {
      const headers = new Headers();
      if (url.startsWith("http://127.0.0.1:6901/")) {
        if (!options.viewerAuthorization?.startsWith("Basic ")) return unavailable(c);
        headers.set("authorization", options.viewerAuthorization);
      }
      if (body) headers.set("content-type", "application/json");
      const response = await fetcher(url, {
        method: method ?? c.req.method, headers, ...(body ? { body } : {}),
        signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      if (!response.ok) { await response.body?.cancel(); return unavailable(c); }
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_BODY) { await response.body?.cancel(); return unavailable(c); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BODY || chunks.length >= 1024) { await reader.cancel(); return unavailable(c); }
          chunks.push(value);
        }
      }
      const resultHeaders = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
      for (const name of SAFE_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value) resultHeaders.set(name, value);
      }
      let bytes = Buffer.concat(chunks);
      const request = new URL(c.req.url);
      if ((request.pathname === `${PREFIX}/viewer/` || request.pathname === `${PREFIX}/viewer/index.html`) && request.searchParams.get("matrix_product") === "1" && c.req.method !== "HEAD") {
        if (!resultHeaders.get("content-type")?.includes("text/html")) return unavailable(c);
        const parent = request.searchParams.get('matrix_parent_origin');
        if (parent) {
          const parsed = new URL(parent);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== parent || !options.isAllowedOrigin(parent)) return c.json({ error: 'Forbidden' }, 403);
        }
        bytes = Buffer.from(injectViewerBridge(bytes.toString("utf8"), parent ?? undefined));
      }
      return new Response(c.req.method === "HEAD" ? null : bytes, { status: response.status, headers: resultHeaders });
    } catch (error) {
      console.warn("[browser-lab] Upstream request failed", error instanceof Error ? error.name : "unknown");
      return unavailable(c);
    } finally { activeHttp--; }
  }
  async function productRequest(c: Context, path: "browser-status" | "browser-control" | "browser-session" | "browser-observe", body?: string) {
    const response = await proxy(c, `http://127.0.0.1:8730/${path}`, body, path === "browser-status" ? "GET" : undefined);
    if (!response.ok) return response;
    try {
      const text = await response.text();
      if (text.length > 4096) return unavailable(c);
      const parsed = PRODUCT_STATUS.safeParse(JSON.parse(text));
      if (!parsed.success) return unavailable(c);
      return c.json({ ...parsed.data, ...(options.sharedBrowser ? { automation: options.sharedBrowser.broker.status() } : {}) }, 200, { "Cache-Control": "no-store" });
    } catch (error) { console.warn("[browser-lab] Product status decoding failed", error instanceof Error ? error.name : "unknown"); return unavailable(c); }
  }
  async function decode(c: Context, schema: typeof PRODUCT_CONTROL | typeof PRODUCT_SESSION) {
    try { return schema.safeParse(await c.req.json()); }
    catch (error) { if (!(error instanceof SyntaxError)) console.warn("[browser-lab] Product control decoding failed", error instanceof Error ? error.name : "unknown"); return null; }
  }
  app.get(`${PREFIX}/api/browser-status`, async (c) => allowed(c) ? productRequest(c, "browser-status") : c.json({ error: "Forbidden" }, 403));
  app.post(`${PREFIX}/api/browser-control`, bodyLimit({ maxSize: 4096 }), async c => {
    if (!allowed(c)) return c.json({ error: "Forbidden" }, 403);
    const parsed = await decode(c, PRODUCT_CONTROL);
    if (!parsed?.success) return c.json({ error: "Invalid control" }, 400);
    if (options.sharedBrowser) {
      try { return await options.sharedBrowser.broker.ownerOperation(options.sharedBrowser.ownerId,
        () => productRequest(c, "browser-control", JSON.stringify(parsed.data))); }
      catch (error) { if (error instanceof SharedBrowserError) return c.json({ error: "Take over Chrome before using this control." }, 409); throw error; }
    }
    return productRequest(c, "browser-control", JSON.stringify(parsed.data));
  });
  app.post(`${PREFIX}/api/browser-automation`, bodyLimit({ maxSize: 4096 }), async c => {
    if (!allowed(c)) return c.json({ error: "Forbidden" }, 403);
    if (!options.sharedBrowser) return unavailable(c);
    let raw: unknown;
    try { raw = await c.req.json(); }
    catch (error) { if (error instanceof Error && error.name === "BodyLimitError") throw error;console.warn("[shared-browser] Owner control decoding unavailable", error instanceof SyntaxError ? "invalid_json" : "decode_failed"); return c.json({ error: "Invalid control" }, 400); }
    const parsed = SharedBrowserControlSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid control" }, 400);
    try { await options.sharedBrowser.broker.control(options.sharedBrowser.ownerId, parsed.data); }
    catch (error) { console.warn("[shared-browser] Owner control unavailable", error instanceof SharedBrowserError ? error.code : "operation_failed"); return c.json({ error: "Browser control could not be changed." }, 409); }
    return productRequest(c, "browser-status");
  });
  app.post(agentPath, bodyLimit({ maxSize: SHARED_BROWSER_ACTION_MAX_BYTES }), async c => {
    if (!allowed(c)) return c.json({ error: "Forbidden" }, 403);
    const grant = agentGrant(c);
    if (!grant || !options.sharedBrowser) return c.json({ error: "Unauthorized" }, 401);
    if (activeAgent >= 8) return c.json({ error: "Browser service busy" }, 503);
    let raw: unknown;
    try { raw = await c.req.json(); }
    catch (error) { if (error instanceof Error && error.name === "BodyLimitError") throw error;console.warn("[shared-browser] Agent action decoding unavailable", error instanceof SyntaxError ? "invalid_json" : "decode_failed"); return c.json({ error: "Invalid browser action" }, 400); }
    const parsed = SharedBrowserActionSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid browser action" }, 400);
    if (!options.sharedBrowser.broker.resolveCapability(grant.token)) return c.json({ error: "Unauthorized" }, 401);
    activeAgent++;
    try {
      const value = await options.sharedBrowser.broker.execute(grant.binding, parsed.data,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(SHARED_BROWSER_ACTION_DEADLINE_MS)]));
      if (Buffer.byteLength(JSON.stringify(value)) > 192 * 1024) return unavailable(c);
      return c.json(value, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof SharedBrowserError && !error.dispatched && ["observe_again", "browser_changed", "browser_busy"].includes(error.code)) {
        return c.json({ success: false, content: error.message, automation: options.sharedBrowser.broker.status() }, 200, { "Cache-Control": "no-store" });
      }
      console.warn("[shared-browser] Agent action unavailable", error instanceof SharedBrowserError ? error.code : "operation_failed");
      return c.json({ error: "The browser action is unavailable. Its effect must be checked before retrying." }, 409);
    } finally { activeAgent--; }
  });
  app.post(`${PREFIX}/api/browser-session`, bodyLimit({ maxSize: 4096 }), async c => {
    if (!allowed(c)) return c.json({ error: "Forbidden" }, 403);
    const parsed = await decode(c, PRODUCT_SESSION);
    if (!parsed?.success || !("surface" in parsed.data)) return c.json({ error: "Invalid control" }, 400);
    const session = c.get("appSession" as never) as AppSessionPayloadType;
    const generation = ++claimGeneration;
    productClaim = { generation, expiresAt: session.exp * 1000, pendingUntil: Math.min(Date.now() + 60_000, session.exp * 1000), connected: false };
    tickets.clear(); sockets?.closeConnections();
    let status: Response;
    try {
      const shared = options.sharedBrowser;
      const automation = shared?.broker.status();
      // A fresh supervisor starts with human input disabled. Admit an idle
      // owner through the same serialized gate as native window controls.
      // An ongoing Chat is only observed; opening a viewer never takes it over.
      status = shared && automation?.phase === "idle" && automation.run === null
        ? await shared.broker.ownerOperation(shared.ownerId,
          () => productRequest(c, "browser-session", JSON.stringify(parsed.data)))
        : await productRequest(c, shared ? "browser-observe" : "browser-session", JSON.stringify(parsed.data));
    } catch (error) {
      if (productClaim?.generation === generation) productClaim = undefined;
      if (error instanceof SharedBrowserError) return c.json({ error: "Browser control changed. Reconnect to continue." }, 409);
      console.warn("[shared-browser] Viewer admission unavailable", "operation_failed");
      return unavailable(c);
    }
    if (!status.ok) { if (productClaim?.generation === generation) productClaim = undefined; return status; }
    const acknowledged = await status.json() as z.infer<typeof PRODUCT_STATUS>;
    if (!acknowledged.available || !options.sharedBrowser && !acknowledged.humanControlAvailable || parsed.data.surface === 'browser' && !acknowledged.chrome.present) { if (productClaim?.generation === generation) productClaim = undefined; return unavailable(c); }
    if (closed || productClaim?.generation !== generation || Date.now() >= session.exp * 1000) return c.json({ error: "Browser session superseded" }, 409);
    const ticket = randomBytes(24).toString("hex");
    const expiresAt = Math.min(Date.now() + 60_000, session.exp * 1000);
    productClaim.pendingUntil = expiresAt;
    tickets.set(ticket, { expiresAt, session, claim: generation });
    return c.json({ ticket, expiresAt }, 200, { "Cache-Control": "no-store" });
  });

  app.get(`${PREFIX}/api/viewer-session`, (c) => {
    if (!allowed(c)) return c.json({ error: "Forbidden" }, 403);
    sweepTickets();
    if (productClaim) return c.json({ error: "Browser session in use" }, 409);
    if (tickets.size >= 8) return c.json({ error: "Browser service busy" }, 503);
    const session = c.get("appSession" as never) as AppSessionPayloadType;
    const ticket = randomBytes(24).toString("hex");
    const expiresAt = Math.min(Date.now() + 60_000, session.exp * 1000);
    tickets.set(ticket, { expiresAt, session });
    return c.json({ ticket, expiresAt }, 200, { "Cache-Control": "no-store" });
  });
  app.get(`${PREFIX}/api/status`, async (c) => {
    const response = await proxy(c, "http://127.0.0.1:8730/status");
    if (response.ok) response.headers.set("x-matrix-browser-lab-comparison", options.sharedBrowser ? "disabled" : "enabled");
    return response;
  });
  app.post(`${PREFIX}/api/control`, bodyLimit({ maxSize: 4096 }), async (c) => {
    // The diagnostic supervisor is a separate legacy controller. Once Chat
    // owns the shared broker, it must never independently enable viewer input.
    if(options.sharedBrowser)return c.json({error:"Use Browser controls for this session."},409);
    if (!allowed(c)) return c.json({ error: "Forbidden" }, 403);
    sweepTickets();
    if (productClaim) return c.json({ error: "Browser session in use" }, 409);
    let raw: unknown;
    try { raw = await c.req.json(); }
    catch (error) {
      if (!(error instanceof SyntaxError)) console.warn("[browser-lab] Control decoding failed", error instanceof Error ? error.name : "unknown");
      return c.json({ error: "Invalid control" }, 400);
    }
    const parsed = CONTROL.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid control" }, 400);
    sweepTickets();
    if (productClaim) return c.json({ error: "Browser session in use" }, 409);
    return proxy(c, "http://127.0.0.1:8730/control", JSON.stringify(parsed.data));
  });
  app.get(`${PREFIX}/viewer/websockify`, async (c) => {
    if (!allowed(c)) return c.json({ error: "Forbidden" }, 403);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "Upgrade required" }, 426);
    if (!options.upgradeWebSocket) return unavailable(c);
    const session = c.get("appSession" as never) as AppSessionPayloadType;
    const claim = c.get("browserLabClaim" as never) as number | undefined;
    const events = await sockets?.connect(session.exp * 1000, () => { if (claim !== undefined && productClaim?.generation === claim) productClaim = undefined; });
    if (!events) return unavailable(c);
    if (claim !== undefined && productClaim?.generation === claim) productClaim.connected = true;
    return options.upgradeWebSocket(() => events)(c, async () => {});
  });
  app.get(`${PREFIX}/viewer/matrix-viewer-bridge.mjs`, c => c.body(VIEWER_BRIDGE_SCRIPT, 200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }));
  app.all(`${PREFIX}/viewer/*`, bodyLimit({ maxSize: 4096 }), async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "Method not allowed" }, 405);
    const path = c.req.path.slice(`${PREFIX}/viewer/`.length);
    const parsed = PATH.safeParse(path);
    const query = new URL(c.req.url).search;
    if (!parsed.success || query.length > 2048) return c.json({ error: "Invalid viewer path" }, 400);
    return proxy(c, `http://127.0.0.1:6901/${parsed.data}${query}`);
  });
  app.all(`${PREFIX}/api/*`, bodyLimit({ maxSize: 4096 }), (c) => c.json({ error: "not_found" }, 404));
  if (options.sharedBrowser || options.setupOwnerId) {
    // OS-owned bundle payload. OS Browser must never fall through to a
    // same-named owner app, including for unrecognized static paths.
    app.all(`${PREFIX}/*`, bodyLimit({ maxSize: 4096 }), async c => {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "Method not allowed" }, 405);
      const path = c.req.path.slice(`${PREFIX}/`.length);
      if (!PATH.safeParse(path).success || new URL(c.req.url).search.length > 2048) return c.json({ error: "Invalid browser path" }, 400);
      const entry = path === "" || path === "index.html";
      if (!entry && !/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(path)) return c.json({ error: "not_found" }, 404);
      const flatSetupUi = Boolean(options.setupOwnerId);
      const file = flatSetupUi ? `matrix-browser-ui-${entry ? "index.html" : path.slice("assets/".length)}` : path;
      const response = await serveStaticFileWithin(options.productUiPath ?? (flatSetupUi ? "/opt/matrix/bin" : "/opt/matrix-browser-lab/app/lab/dist"), file, c, { spaFallback: false });
      if (entry && response.status === 404) return unavailable(c);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      if (c.req.method === "HEAD") {
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers: response.headers });
      }
      return response;
    });
  }
  return { close() { closed = true; productClaim = undefined; if (ticketTimer) clearInterval(ticketTimer); tickets.clear(); sockets?.close(); } };
}
