import { WebContentsView, shell, session, net, app, Menu, BrowserWindow, safeStorage, Notification, ipcMain } from "electron";
import { join } from "node:path";
import { rm, readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const CATEGORY_MESSAGES = {
  unauthorized: "Your session has expired. Please sign in again.",
  offline: "Can't reach Matrix OS. Check your connection.",
  timeout: "The request timed out. Please try again.",
  notFound: "That item could not be found.",
  server: "Something went wrong. Please try again.",
  misconfigured: "No computer is connected. Select a runtime to continue.",
  fatalSession: "This session has ended."
};
class AppError extends Error {
  category;
  constructor(category, options) {
    super(CATEGORY_MESSAGES[category], options);
    this.name = "AppError";
    this.category = category;
  }
}
function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "notFound";
  return "server";
}
function classifyTransportError(err) {
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "timeout";
  }
  if (err instanceof TypeError) return "offline";
  return "server";
}
const DEVICE_CLIENT_ID = "matrix-os-desktop";
const DEVICE_REDIRECT_URI = "matrix-os://device-auth";
const REQUEST_TIMEOUT_MS = 1e4;
class DeviceFlowError extends Error {
  code;
  constructor(code) {
    super(code === "expired" ? "Sign-in request expired. Start again." : "Sign-in was denied.");
    this.name = "DeviceFlowError";
    this.code = code;
  }
}
async function postJson(fetchFn, url, body) {
  try {
    return await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    throw new AppError(classifyTransportError(err), { cause: err });
  }
}
async function parseJson(response) {
  try {
    const data = await response.json();
    if (data && typeof data === "object") return data;
  } catch (err) {
    throw new AppError("server", { cause: err });
  }
  throw new AppError("server");
}
async function requestDeviceCode(options) {
  const response = await postJson(options.fetchFn, `${options.baseUrl}/api/auth/device/code`, {
    clientId: DEVICE_CLIENT_ID,
    redirectUri: DEVICE_REDIRECT_URI
  });
  if (!response.ok) {
    throw new AppError(classifyHttpStatus(response.status));
  }
  const data = await parseJson(response);
  const { deviceCode, userCode, verificationUri, expiresIn, interval } = data;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string" || typeof expiresIn !== "number" || typeof interval !== "number") {
    throw new AppError("server");
  }
  return { deviceCode, userCode, verificationUri, expiresIn, interval };
}
async function pollForToken(options) {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + options.expiresInSeconds * 1e3;
  let intervalMs = Math.max(1, options.intervalSeconds) * 1e3;
  for (; ; ) {
    const response = await postJson(options.fetchFn, `${options.baseUrl}/api/auth/device/token`, {
      deviceCode: options.deviceCode
    });
    if (response.status === 200) {
      const data = await parseJson(response);
      const { accessToken, expiresAt, userId, handle } = data;
      if (typeof accessToken !== "string" || typeof expiresAt !== "number" || typeof userId !== "string" || typeof handle !== "string") {
        throw new AppError("server");
      }
      return { accessToken, expiresAt, userId, handle };
    }
    if (response.status === 410) throw new DeviceFlowError("expired");
    if (response.status === 429) {
      intervalMs += 5e3;
    } else if (response.status !== 428) {
      throw new AppError(classifyHttpStatus(response.status));
    }
    if (clock() + intervalMs > deadline) throw new DeviceFlowError("expired");
    await options.sleep(intervalMs);
  }
}
class AuthService {
  credential = null;
  profile = null;
  flowState = "idle";
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  async init() {
    this.credential = await this.deps.credentialStore.load();
    this.profile = await this.deps.loadProfile();
  }
  getToken() {
    return this.credential?.accessToken ?? null;
  }
  getGatewayOrigin() {
    return this.profile?.platformHost ?? this.deps.platformHost;
  }
  getStatus() {
    const signedIn = this.credential !== null;
    return {
      signedIn,
      ...signedIn && this.profile ? { handle: this.profile.handle } : {},
      runtimeSlot: this.profile?.runtimeSlot ?? "primary",
      platformHost: this.getGatewayOrigin()
    };
  }
  async startDeviceFlow() {
    const fetchFn = this.deps.fetchFn ?? ((input, init) => fetch(input, init));
    const baseUrl = this.getGatewayOrigin();
    const code = await requestDeviceCode({ fetchFn, baseUrl });
    this.flowState = "pending";
    void pollForToken({
      fetchFn,
      baseUrl,
      deviceCode: code.deviceCode,
      intervalSeconds: code.interval,
      expiresInSeconds: code.expiresIn,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    }).then(async (token) => {
      this.credential = token;
      this.profile = {
        handle: token.handle,
        userId: token.userId,
        platformHost: baseUrl,
        runtimeSlot: this.profile?.runtimeSlot ?? "primary"
      };
      await this.deps.credentialStore.save(token);
      await this.deps.saveProfile(this.profile);
      this.flowState = "authorized";
      this.deps.onAuthChanged(this.getStatus());
    }).catch((err) => {
      if (err instanceof DeviceFlowError) {
        this.flowState = "expired";
        return;
      }
      console.warn(
        "[auth] device flow failed:",
        err instanceof Error ? err.message : String(err)
      );
      this.flowState = "expired";
    });
    void this.deps.openExternal(code.verificationUri).catch((err) => {
      console.warn(
        "[auth] failed to open verification url:",
        err instanceof Error ? err.message : String(err)
      );
    });
    return {
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresIn: code.expiresIn
    };
  }
  poll() {
    if (this.flowState === "authorized" && this.profile) {
      return {
        status: "authorized",
        profile: { handle: this.profile.handle, userId: this.profile.userId }
      };
    }
    if (this.flowState === "expired") return { status: "expired" };
    return { status: "pending" };
  }
  async selectRuntime(slot) {
    if (!this.profile) return;
    this.profile = { ...this.profile, runtimeSlot: slot };
    await this.deps.saveProfile(this.profile);
  }
  async signOut() {
    this.credential = null;
    this.profile = null;
    this.flowState = "idle";
    await this.deps.credentialStore.clear();
    await this.deps.clearProfile();
    this.deps.onAuthChanged(this.getStatus());
  }
}
function createCredentialStore(options) {
  const filePath = join(options.dir, "credential.bin");
  return {
    async save(credential) {
      if (!options.safeStorage.isEncryptionAvailable()) {
        throw new Error("OS encryption unavailable; refusing to store credential in plain text");
      }
      await mkdir(options.dir, { recursive: true });
      const encrypted = options.safeStorage.encryptString(JSON.stringify(credential));
      const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmpPath, encrypted);
      await rename(tmpPath, filePath);
    },
    async load() {
      let blob;
      try {
        blob = await readFile(filePath);
      } catch (err) {
        if (err.code === "ENOENT") return null;
        console.warn(
          "[credential-store] failed to read credential:",
          err instanceof Error ? err.message : String(err)
        );
        return null;
      }
      try {
        const parsed = JSON.parse(options.safeStorage.decryptString(blob));
        if (parsed && typeof parsed === "object" && typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "number" && typeof parsed.userId === "string" && typeof parsed.handle === "string") {
          return parsed;
        }
      } catch (err) {
        console.warn(
          "[credential-store] failed to decrypt credential, treating as signed out:",
          err instanceof Error ? err.message : String(err)
        );
      }
      return null;
    },
    async clear() {
      await rm(filePath, { force: true });
    }
  };
}
function normalizeWsScheme(url) {
  if (url.protocol === "ws:") return "http:";
  if (url.protocol === "wss:") return "https:";
  return url.protocol;
}
function shouldInjectAuth(requestUrl, gatewayOrigin) {
  if (!gatewayOrigin) return false;
  let request;
  let gateway;
  try {
    request = new URL(requestUrl);
    gateway = new URL(gatewayOrigin);
  } catch {
    return false;
  }
  return normalizeWsScheme(request) === normalizeWsScheme(gateway) && request.hostname === gateway.hostname && request.port === gateway.port;
}
function installHeaderInjection(rendererSession, getToken, getGatewayOrigin) {
  rendererSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const token = getToken();
    if (token && shouldInjectAuth(details.url, getGatewayOrigin())) {
      details.requestHeaders["Authorization"] = `Bearer ${token}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}
const MAX_TOTAL_EMBEDS = 12;
const DEFAULT_MAX_LIVE = 3;
const SAFE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
class EmbedManager {
  records = /* @__PURE__ */ new Map();
  createView;
  maxLive;
  tick = 0;
  constructor(options) {
    this.createView = options.createView;
    this.maxLive = options.maxLive ?? DEFAULT_MAX_LIVE;
  }
  open(kind, slug, bounds, url) {
    const partition = kind === "hosted-shell" ? "persist:hosted-shell" : this.appPartition(slug);
    const id = randomUUID();
    const view = this.createView({ partition });
    const record = {
      id,
      url,
      view,
      live: true,
      loadFailed: false,
      lastUsed: ++this.tick
    };
    view.attach();
    view.setBounds(bounds);
    this.loadInto(record);
    this.records.set(id, record);
    this.enforceMaxLive();
    this.enforceTotalCap();
    return id;
  }
  setBounds(embedId, bounds) {
    const record = this.records.get(embedId);
    if (!record) return false;
    record.view.setBounds(bounds);
    return true;
  }
  focus(embedId) {
    const record = this.records.get(embedId);
    if (!record) return false;
    record.lastUsed = ++this.tick;
    if (!record.live) {
      record.view.attach();
      record.live = true;
    }
    if (record.loadFailed) {
      record.loadFailed = false;
      this.loadInto(record);
    }
    this.enforceMaxLive();
    return true;
  }
  close(embedId) {
    const record = this.records.get(embedId);
    if (!record) return false;
    record.view.destroy();
    this.records.delete(embedId);
    return true;
  }
  closeAll() {
    for (const record of this.records.values()) record.view.destroy();
    this.records.clear();
  }
  has(embedId) {
    return this.records.has(embedId);
  }
  get liveCount() {
    let count = 0;
    for (const record of this.records.values()) if (record.live) count += 1;
    return count;
  }
  appPartition(slug) {
    if (!slug || !SAFE_SLUG.test(slug)) {
      throw new Error("invalid app slug for embed partition");
    }
    return `persist:app-${slug}`;
  }
  loadInto(record) {
    void record.view.loadUrl(record.url).catch((err) => {
      console.warn(
        "[embed-manager] embed load failed:",
        err instanceof Error ? err.message : String(err)
      );
      record.loadFailed = true;
    });
  }
  enforceMaxLive() {
    while (this.liveCount > this.maxLive) {
      const victim = this.leastRecentlyUsed((r) => r.live);
      if (!victim) break;
      victim.view.detach();
      victim.live = false;
    }
  }
  enforceTotalCap() {
    while (this.records.size > MAX_TOTAL_EMBEDS) {
      const victim = this.leastRecentlyUsed((r) => !r.live) ?? this.leastRecentlyUsed(() => true);
      if (!victim) break;
      victim.view.destroy();
      this.records.delete(victim.id);
    }
  }
  leastRecentlyUsed(predicate) {
    let chosen = null;
    for (const record of this.records.values()) {
      if (!predicate(record)) continue;
      if (!chosen || record.lastUsed < chosen.lastUsed) chosen = record;
    }
    return chosen;
  }
}
const TTL_MARGIN_MS = 3e4;
const DEFAULT_CAP = 32;
class LaunchTokenCache {
  entries = /* @__PURE__ */ new Map();
  cap;
  clock;
  constructor(options) {
    this.cap = options?.cap ?? DEFAULT_CAP;
    this.clock = options?.clock ?? Date.now;
  }
  get(slug) {
    const token = this.entries.get(slug);
    if (!token) return null;
    if (this.clock() > token.expiresAt - TTL_MARGIN_MS) return null;
    this.entries.delete(slug);
    this.entries.set(slug, token);
    return token;
  }
  set(slug, token) {
    if (this.entries.has(slug)) this.entries.delete(slug);
    this.entries.set(slug, token);
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest === void 0) break;
      this.entries.delete(oldest);
    }
  }
  clear() {
    this.entries.clear();
  }
}
const REQUIRED_COOKIES = ["matrix_app_session", "matrix_native_app_session"];
function mapSameSite(value) {
  switch (value.toLowerCase()) {
    case "lax":
      return "lax";
    case "strict":
      return "strict";
    case "none":
      return "no_restriction";
    default:
      return "unspecified";
  }
}
function parseOne(header) {
  const parts = header.split(";");
  const first = (parts[0] ?? "").trim();
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  if (name.length === 0) return null;
  const value = first.slice(eq + 1);
  const cookie = { name, value };
  let maxAgeSeconds = null;
  for (let i = 1; i < parts.length; i += 1) {
    const attr = parts[i].trim();
    if (attr.length === 0) continue;
    const aeq = attr.indexOf("=");
    const key = (aeq === -1 ? attr : attr.slice(0, aeq)).trim().toLowerCase();
    const val = aeq === -1 ? "" : attr.slice(aeq + 1).trim();
    switch (key) {
      case "path":
        cookie.path = val;
        break;
      case "domain":
        cookie.domain = val;
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "samesite":
        cookie.sameSite = mapSameSite(val);
        break;
      case "expires": {
        const ts = Date.parse(val);
        if (!Number.isNaN(ts)) cookie.expires = ts;
        break;
      }
      case "max-age": {
        const n = Number(val);
        if (Number.isFinite(n)) maxAgeSeconds = n;
        break;
      }
    }
  }
  if (maxAgeSeconds !== null) cookie.expires = Date.now() + maxAgeSeconds * 1e3;
  return cookie;
}
function parseSetCookieHeaders(headers) {
  const cookies = [];
  for (const header of headers) {
    const cookie = parseOne(header);
    if (cookie) cookies.push(cookie);
    else console.warn("[app-session] skipping malformed Set-Cookie header");
  }
  return cookies;
}
function verifyCookiePair(cookies) {
  return REQUIRED_COOKIES.every(
    (name) => cookies.some((cookie) => cookie.name === name && cookie.value.length > 0)
  );
}
function isStaleClerkCookie(cookie) {
  if (cookie.name.startsWith("__client") || cookie.name.startsWith("__session")) return true;
  if (cookie.domain && cookie.domain.toLowerCase().includes("clerk")) return true;
  return false;
}
async function performAppSessionHandoff(deps, redirectTo) {
  let response;
  try {
    response = await deps.request(`${deps.gatewayOrigin}/api/auth/app-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirectTo })
    });
  } catch (err) {
    console.warn(
      "[app-session] handoff request failed:",
      err instanceof Error ? err.message : String(err)
    );
    return { ok: false, reason: "unavailable" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "auth" };
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: "unavailable" };
  const cookies = parseSetCookieHeaders(response.setCookieHeaders);
  if (!verifyCookiePair(cookies)) return { ok: false, reason: "auth" };
  try {
    const existing = await deps.cookieJar.get({});
    for (const cookie of existing) {
      if (isStaleClerkCookie(cookie)) await deps.cookieJar.remove(deps.gatewayOrigin, cookie.name);
    }
    for (const name of REQUIRED_COOKIES) {
      const cookie = cookies.find((c) => c.name === name);
      if (cookie) await deps.cookieJar.set({ ...cookie, url: deps.gatewayOrigin });
    }
  } catch (err) {
    console.warn(
      "[app-session] cookie installation failed:",
      err instanceof Error ? err.message : String(err)
    );
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true };
}
async function handoffWithRetry(deps, redirectTo) {
  const first = await performAppSessionHandoff(deps, redirectTo);
  if (first.ok || first.reason === "auth") return first;
  return performAppSessionHandoff(deps, redirectTo);
}
function resolveLaunchUrl(launchUrl, gatewayOrigin) {
  if (!launchUrl.startsWith("/") || launchUrl.startsWith("//")) return null;
  let gateway;
  try {
    gateway = new URL(gatewayOrigin);
  } catch {
    return null;
  }
  let resolved;
  try {
    resolved = new URL(launchUrl, gateway);
  } catch {
    return null;
  }
  if (resolved.origin !== gateway.origin) return null;
  return resolved.toString();
}
function isNavigationAllowed(targetUrl, allowedOrigins) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return false;
  for (const origin of allowedOrigins) {
    let allowed;
    try {
      allowed = new URL(origin);
    } catch {
      continue;
    }
    if (target.origin === allowed.origin) return true;
  }
  return false;
}
function createWebContentsView(options) {
  const view = new WebContentsView({
    webPreferences: {
      partition: options.partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  const contents = view.webContents;
  contents.on("will-navigate", (event, url) => {
    if (!isNavigationAllowed(url, options.allowedOrigins)) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-start-loading", () => options.onState("loading"));
  contents.on("did-finish-load", () => options.onState("ready"));
  contents.on("did-fail-load", (_e, errorCode) => {
    if (errorCode !== -3) options.onState("failed");
  });
  let attached = false;
  return {
    setBounds(bounds) {
      view.setBounds(bounds);
    },
    async loadUrl(url) {
      await contents.loadURL(url);
    },
    attach() {
      if (attached) return;
      options.window.contentView.addChildView(view);
      attached = true;
    },
    detach() {
      if (!attached) return;
      options.window.contentView.removeChildView(view);
      attached = false;
    },
    destroy() {
      if (attached) {
        options.window.contentView.removeChildView(view);
        attached = false;
      }
      if (!contents.isDestroyed()) contents.close();
    }
  };
}
class EmbedService {
  manager;
  tokenCache = new LaunchTokenCache();
  deps;
  constructor(deps) {
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
          onState: () => void 0
        });
      }
    });
  }
  async open(request) {
    const gatewayOrigin = this.deps.getGatewayOrigin();
    if (request.kind === "hosted-shell") {
      return this.openHostedShell(gatewayOrigin, request.bounds);
    }
    return this.openApp(gatewayOrigin, request.slug ?? "", request.bounds);
  }
  setBounds(embedId, bounds) {
    return this.manager.setBounds(embedId, bounds);
  }
  close(embedId) {
    return this.manager.close(embedId);
  }
  closeAll() {
    this.manager.closeAll();
  }
  async retryAuth(embedId) {
    if (!this.manager.has(embedId)) return false;
    return this.manager.focus(embedId);
  }
  cookieJarFor(partition) {
    const jar = session.fromPartition(partition).cookies;
    return {
      get: async () => {
        const cookies = await jar.get({});
        return cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path }));
      },
      set: async (cookie) => {
        await jar.set({
          url: cookie.url,
          name: cookie.name,
          value: cookie.value,
          ...cookie.domain ? { domain: cookie.domain } : {},
          ...cookie.path ? { path: cookie.path } : {},
          ...cookie.secure !== void 0 ? { secure: cookie.secure } : {},
          ...cookie.httpOnly !== void 0 ? { httpOnly: cookie.httpOnly } : {},
          ...cookie.expires !== void 0 ? { expirationDate: cookie.expires / 1e3 } : {}
        });
      },
      remove: async (url, name) => {
        await jar.remove(url, name);
      }
    };
  }
  async openHostedShell(gatewayOrigin, bounds) {
    const handoff = await handoffWithRetry(
      {
        gatewayOrigin,
        cookieJar: this.cookieJarFor("persist:hosted-shell"),
        request: (url2, init) => this.gatewayRequest(url2, init)
      },
      "/"
    );
    const url = `${gatewayOrigin}/`;
    const embedId = this.manager.open("hosted-shell", null, bounds, url);
    if (!handoff.ok) {
      this.deps.emitState(embedId, "auth-required");
    }
    return embedId;
  }
  async openApp(gatewayOrigin, slug, bounds) {
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
  async fetchLaunchToken(gatewayOrigin, slug) {
    try {
      const response = await this.gatewayRequest(
        `${gatewayOrigin}/api/apps/${encodeURIComponent(slug)}/session-token`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
      );
      if (response.status < 200 || response.status >= 300) return null;
      const parsed = JSON.parse(response.body);
      if (parsed && typeof parsed === "object" && typeof parsed.launchUrl === "string" && typeof parsed.expiresAt === "number") {
        const { launchUrl, expiresAt } = parsed;
        return { launchUrl, expiresAt };
      }
      return null;
    } catch (err) {
      console.warn(
        "[embed-service] launch token fetch failed:",
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }
  gatewayRequest(url, init) {
    return new Promise((resolve, reject) => {
      const token = this.deps.getToken();
      const request = net.request({ method: init.method, url });
      for (const [key, value] of Object.entries(init.headers)) request.setHeader(key, value);
      if (token) request.setHeader("Authorization", `Bearer ${token}`);
      const timeout = setTimeout(() => {
        request.abort();
        reject(new Error("gateway request timed out"));
      }, 1e4);
      request.on("response", (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          clearTimeout(timeout);
          const rawSetCookie = response.headers["set-cookie"];
          const setCookieHeaders = Array.isArray(rawSetCookie) ? rawSetCookie : typeof rawSetCookie === "string" ? [rawSetCookie] : [];
          resolve({
            status: response.statusCode,
            setCookieHeaders,
            body: Buffer.concat(chunks).toString("utf8")
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
const Empty = z.object({}).strict();
const Ok = z.object({ ok: z.boolean() }).strict();
const ProfileSchema$1 = z.object({
  handle: z.string().min(1).max(64),
  userId: z.string().min(1).max(128)
}).strict();
const BoundsSchema = z.object({
  x: z.number().int().min(-16384).max(16384),
  y: z.number().int().min(-16384).max(16384),
  width: z.number().int().min(0).max(16384),
  height: z.number().int().min(0).max(16384)
}).strict();
const STATE_KEYS = [
  "windowBounds",
  "lastProjectSlug",
  "panelLayouts",
  "appearance",
  "recents"
];
const MAX_STATE_VALUE_BYTES = 64 * 1024;
const BoundedJsonValue = z.unknown().refine(
  (value) => {
    try {
      return JSON.stringify(value).length <= MAX_STATE_VALUE_BYTES;
    } catch {
      return false;
    }
  },
  { message: "state value too large" }
);
const INVOKE_CHANNELS = {
  "auth:start-device-flow": {
    request: Empty,
    response: z.object({
      userCode: z.string().min(1).max(32),
      verificationUri: z.string().max(512),
      expiresIn: z.number().int().positive()
    }).strict()
  },
  "auth:poll": {
    request: Empty,
    response: z.object({
      status: z.enum(["pending", "authorized", "expired"]),
      profile: ProfileSchema$1.optional()
    }).strict()
  },
  "auth:status": {
    request: Empty,
    response: z.object({
      signedIn: z.boolean(),
      handle: z.string().max(64).optional(),
      runtimeSlot: z.string().max(64),
      platformHost: z.string().max(256)
    }).strict()
  },
  "auth:sign-out": { request: Empty, response: Ok },
  "runtime:select": {
    request: z.object({ slot: z.string().min(1).max(64) }).strict(),
    response: Ok
  },
  "state:get": {
    request: z.object({ key: z.enum(STATE_KEYS) }).strict(),
    response: z.object({ value: z.unknown() }).strict()
  },
  "state:set": {
    request: z.object({ key: z.enum(STATE_KEYS), value: BoundedJsonValue }).strict(),
    response: Ok
  },
  "embed:open": {
    request: z.object({
      kind: z.enum(["hosted-shell", "app"]),
      slug: z.string().min(1).max(128).optional(),
      bounds: BoundsSchema
    }).strict(),
    response: z.object({ embedId: z.string().min(1).max(64) }).strict()
  },
  "embed:set-bounds": {
    request: z.object({ embedId: z.string().min(1).max(64), bounds: BoundsSchema }).strict(),
    response: Ok
  },
  "embed:close": {
    request: z.object({ embedId: z.string().min(1).max(64) }).strict(),
    response: Ok
  },
  "embed:retry-auth": {
    request: z.object({ embedId: z.string().min(1).max(64) }).strict(),
    response: Ok
  },
  notify: {
    request: z.object({
      threadId: z.string().min(1).max(128),
      title: z.string().min(1).max(80),
      body: z.string().max(200),
      kind: z.enum(["done", "failed", "attention", "connection"])
    }).strict(),
    response: Ok
  },
  "badge:set": {
    request: z.object({ count: z.number().int().min(0).max(999) }).strict(),
    response: Ok
  },
  "shell:open-external": {
    request: z.object({
      url: z.string().max(2048).refine((value) => {
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      }, "https urls only")
    }).strict(),
    response: Ok
  },
  "update:check": {
    request: Empty,
    response: z.object({ status: z.enum(["disabled", "checking", "up-to-date", "downloading", "ready"]) }).strict()
  }
};
const EVENT_CHANNELS = {
  "auth:changed": z.object({ signedIn: z.boolean(), handle: z.string().max(64).optional() }).strict(),
  "runtime:changed": z.object({ slot: z.string().min(1).max(64) }).strict(),
  "embed:state": z.object({
    embedId: z.string().min(1).max(64),
    state: z.enum(["loading", "ready", "auth-required", "failed"])
  }).strict(),
  "notification:clicked": z.object({ threadId: z.string().min(1).max(128) }).strict(),
  "update:available": z.object({ version: z.string().max(64) }).strict(),
  "update:ready": z.object({ version: z.string().max(64) }).strict(),
  "window:focus-changed": z.object({ focused: z.boolean() }).strict(),
  "menu:action": z.object({ action: z.enum(["new-task", "new-thread", "palette", "quick-open"]) }).strict(),
  "menu:navigate": z.object({ kind: z.enum(["settings", "board"]) }).strict()
};
function registerIpcHandlers(ipcMain2, ctx) {
  function handle(channel, handler) {
    ipcMain2.handle(channel, async (_event, rawPayload) => {
      const parsedRequest = INVOKE_CHANNELS[channel].request.safeParse(rawPayload ?? {});
      if (!parsedRequest.success) {
        console.warn(`[ipc] rejected malformed request on ${channel}`);
        throw new Error("invalid request");
      }
      const result = await handler(parsedRequest.data);
      const parsedResponse = INVOKE_CHANNELS[channel].response.safeParse(result);
      if (!parsedResponse.success) {
        console.warn(`[ipc] handler for ${channel} produced an invalid response`);
        throw new Error("internal error");
      }
      return parsedResponse.data;
    });
  }
  handle("auth:start-device-flow", () => ctx.auth.startDeviceFlow());
  handle("auth:poll", () => ctx.auth.poll());
  handle("auth:status", () => ctx.auth.getStatus());
  handle("auth:sign-out", async () => {
    await ctx.auth.signOut();
    return { ok: true };
  });
  handle("runtime:select", async ({ slot }) => {
    await ctx.auth.selectRuntime(slot);
    ctx.onRuntimeChanged(slot);
    return { ok: true };
  });
  handle("state:get", async ({ key }) => ({
    value: await ctx.store.get(key)
  }));
  handle("state:set", async ({ key, value }) => {
    try {
      await ctx.store.set(key, value);
    } catch (err) {
      console.warn(
        `[ipc] state:set rejected for key ${key}:`,
        err instanceof Error ? err.message : String(err)
      );
      throw new Error("invalid request");
    }
    return { ok: true };
  });
  handle("shell:open-external", async ({ url }) => {
    await ctx.openExternal(url);
    return { ok: true };
  });
  handle("badge:set", ({ count }) => {
    ctx.setBadgeCount(count);
    return { ok: true };
  });
  handle("notify", (payload) => {
    ctx.notify(payload);
    return { ok: true };
  });
  handle("embed:open", async ({ kind, slug, bounds }) => {
    try {
      const embedId = await ctx.embeds.open({ kind, slug, bounds });
      return { embedId };
    } catch (err) {
      console.warn(
        "[ipc] embed:open failed:",
        err instanceof Error ? err.message : String(err)
      );
      throw new Error("embed unavailable");
    }
  });
  handle("embed:set-bounds", ({ embedId, bounds }) => ({
    ok: ctx.embeds.setBounds(embedId, bounds)
  }));
  handle("embed:close", ({ embedId }) => ({ ok: ctx.embeds.close(embedId) }));
  handle("embed:retry-auth", async ({ embedId }) => ({
    ok: await ctx.embeds.retryAuth(embedId)
  }));
  handle("update:check", () => ({ status: "disabled" }));
}
const PANEL_LAYOUT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1e3;
const AppearanceSchema = z.object({ theme: z.enum(["dark", "light", "system"]) }).strict();
const WindowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
}).strict();
const PanelLayoutSchema = z.object({
  order: z.array(z.string().max(32)).max(12),
  visible: z.record(z.string().max(32), z.boolean()),
  sizes: z.record(z.string().max(32), z.number().min(0).max(100)),
  touchedAt: z.number().int().nonnegative()
}).strict();
const PanelLayoutsSchema = z.record(z.string().max(256), PanelLayoutSchema);
const RecentsSchema = z.array(z.string().max(512)).max(50);
const ProfileSchema = z.object({
  handle: z.string().min(1).max(64),
  userId: z.string().min(1).max(128),
  platformHost: z.string().min(1).max(256),
  runtimeSlot: z.string().min(1).max(64)
}).strict();
const KEY_SCHEMAS = {
  profile: ProfileSchema,
  windowBounds: WindowBoundsSchema,
  lastProjectSlug: z.string().max(256),
  panelLayouts: PanelLayoutsSchema,
  appearance: AppearanceSchema,
  recents: RecentsSchema
};
function createLocalStore(options) {
  const filePath = join(options.dir, "state.json");
  const clock = options.clock ?? Date.now;
  let writeChain = Promise.resolve();
  async function readState() {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
      return {};
    } catch (err) {
      const code = err.code;
      if (code !== "ENOENT") {
        console.warn(
          "[local-store] unreadable state file, starting fresh:",
          err instanceof Error ? err.message : String(err)
        );
      }
      return {};
    }
  }
  async function writeState(state) {
    await mkdir(options.dir, { recursive: true });
    const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tmpPath, filePath);
  }
  function enqueue(mutate) {
    const task = writeChain.then(async () => {
      const state = await readState();
      mutate(state);
      await writeState(state);
    });
    writeChain = task.catch(() => void 0);
    return task;
  }
  function prunePanelLayouts(layouts, now) {
    const pruned = {};
    for (const [key, layout] of Object.entries(layouts)) {
      if (now - layout.touchedAt <= PANEL_LAYOUT_MAX_AGE_MS) {
        pruned[key] = layout;
      }
    }
    return pruned;
  }
  return {
    async get(key) {
      const state = await readState();
      const result = KEY_SCHEMAS[key].safeParse(state[key]);
      if (!result.success) return null;
      return result.data;
    },
    async set(key, value) {
      const parsed = KEY_SCHEMAS[key].parse(value);
      await enqueue((state) => {
        state[key] = parsed;
      });
    },
    async delete(key) {
      await enqueue((state) => {
        delete state[key];
      });
    },
    async setPanelLayout(taskKey, layout) {
      const parsedLayout = PanelLayoutSchema.parse(layout);
      await enqueue((state) => {
        const existing = PanelLayoutsSchema.safeParse(state.panelLayouts);
        const layouts = existing.success ? existing.data : {};
        layouts[taskKey.slice(0, 256)] = parsedLayout;
        state.panelLayouts = prunePanelLayouts(layouts, clock());
      });
    }
  };
}
function installAppMenu(getWindow) {
  const send = (channel, payload) => {
    getWindow()?.webContents.send(channel, payload);
  };
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "Cmd+,",
          click: () => send("menu:navigate", { kind: "settings" })
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Task",
          accelerator: "Cmd+N",
          click: () => send("menu:action", { action: "new-task" })
        },
        {
          label: "New Agent Thread",
          accelerator: "Cmd+J",
          click: () => send("menu:action", { action: "new-thread" })
        },
        { type: "separator" },
        { role: "close" }
      ]
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Command Palette",
          accelerator: "Cmd+K",
          click: () => send("menu:action", { action: "palette" })
        },
        {
          label: "Go to File",
          accelerator: "Cmd+P",
          click: () => send("menu:action", { action: "quick-open" })
        },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...app.isPackaged ? [] : [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }]
      ]
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Matrix OS Documentation",
          click: () => {
            void shell.openExternal("https://matrix-os.com/docs");
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
const DEFAULT_PLATFORM_HOST = "https://app.matrix-os.com";
if (process.env.OPERATOR_USER_DATA_DIR) {
  app.setPath("userData", process.env.OPERATOR_USER_DATA_DIR);
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}
let mainWindow = null;
function sendEvent(channel, payload) {
  const parsed = EVENT_CHANNELS[channel].safeParse(payload);
  if (!parsed.success) {
    console.warn(`[ipc] refusing to send invalid event on ${channel}`);
    return;
  }
  mainWindow?.webContents.send(channel, parsed.data);
}
async function openExternalHttps(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:") return;
  await shell.openExternal(parsed.toString());
}
function createWindow(bounds) {
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 880,
    minHeight: 560,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: "#0e0e13",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalHttps(url);
    return { action: "deny" };
  });
  win.on("focus", () => sendEvent("window:focus-changed", { focused: true }));
  win.on("blur", () => sendEvent("window:focus-changed", { focused: false }));
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return win;
}
app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const store = createLocalStore({ dir: userData });
  const credentialStore = createCredentialStore({ dir: userData, safeStorage });
  const platformHost = process.env.OPERATOR_GATEWAY_URL ?? DEFAULT_PLATFORM_HOST;
  const auth = new AuthService({
    credentialStore,
    platformHost,
    openExternal: openExternalHttps,
    loadProfile: () => store.get("profile"),
    saveProfile: (profile) => store.set("profile", profile),
    clearProfile: () => store.delete("profile"),
    onAuthChanged: (status) => {
      sendEvent("auth:changed", {
        signedIn: status.signedIn,
        ...status.handle ? { handle: status.handle } : {}
      });
    }
  });
  await auth.init();
  installHeaderInjection(
    session.defaultSession,
    () => auth.getToken(),
    () => auth.getGatewayOrigin()
  );
  const embeds = new EmbedService({
    getWindow: () => mainWindow,
    getGatewayOrigin: () => auth.getGatewayOrigin(),
    getToken: () => auth.getToken(),
    emitState: (embedId, state) => sendEvent("embed:state", { embedId, state })
  });
  registerIpcHandlers(ipcMain, {
    auth,
    store,
    embeds,
    openExternal: openExternalHttps,
    setBadgeCount: (count) => {
      app.setBadgeCount(count);
    },
    notify: ({ threadId, title, body }) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body, silent: false });
      notification.on("click", () => {
        mainWindow?.show();
        mainWindow?.focus();
        sendEvent("notification:clicked", { threadId });
      });
      notification.show();
    },
    onRuntimeChanged: (slot) => {
      embeds.closeAll();
      sendEvent("runtime:changed", { slot });
    }
  });
  const savedBounds = await store.get("windowBounds");
  mainWindow = createWindow(savedBounds ?? { width: 1280, height: 820 });
  installAppMenu(() => mainWindow);
  let boundsSaveTimer = null;
  const persistBounds = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const b = mainWindow.getBounds();
      void store.set("windowBounds", { x: b.x, y: b.y, width: b.width, height: b.height }).catch((err) => {
        console.warn(
          "[main] failed to persist window bounds:",
          err instanceof Error ? err.message : String(err)
        );
      });
    }, 500);
  };
  mainWindow.on("resize", persistBounds);
  mainWindow.on("move", persistBounds);
  mainWindow.on("closed", () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    mainWindow = null;
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow({ width: 1280, height: 820 });
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
