/**
 * Deterministic stand-in for the shared bridge host (Synapse admin API plus the
 * mautrix bridgev2 provisioning API behind `/bridges/<network>/`). It records
 * every outbound request so tests can assert what the platform sent, and it
 * rejects requests that omit the platform's timeout, redirect policy, gate
 * header or bearer credential, so a missing production safeguard fails loudly.
 */
export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

export type FakeHandler = (request: RecordedRequest, signal: AbortSignal) => Promise<Response> | Response;

export const HOST_URL = "https://bridge.example.test";
export const SERVER_NAME = "bridge.example.test";
export const ADMIN_TOKEN = "admin-token-0123456789abcdef";
export const GATE_SECRET = "gate-secret-0123456789abcdef";
export const APPSERVICE_TOKEN = "doublepuppet-as-token-0123456789abcdef";
export const PROVISIONING_SECRETS = {
  whatsapp: "prov-whatsapp-0123456789abcdef",
  telegram: "prov-telegram-0123456789abcdef",
  linkedin: "prov-linkedin-0123456789abcdef",
} as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The owner's existing login ids, looked up before every login start to re-link in place. */
const LOGIN_IDS_PATH = /^\/bridges\/[a-z]+\/_matrix\/provision\/v3\/logins$/;

export function createFakeBridgeHost() {
  const requests: RecordedRequest[] = [];
  /** `GET /logins` lookups, kept apart so `requests` reads as the flow-driving calls. */
  const loginIdLookups: RecordedRequest[] = [];
  const loginIds: Record<string, string[]> = {};
  const routes: Array<{ method: string; pattern: RegExp; handler: FakeHandler }> = [];

  function on(method: string, pattern: RegExp, handler: FakeHandler) {
    routes.unshift({ method, pattern, handler });
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (!init?.signal) throw new Error("fake bridge host: request without AbortSignal");
    if (init.redirect !== "error") throw new Error("fake bridge host: request without redirect: error");
    const headers = new Headers(init.headers);
    if (headers.get("x-matrix-bridge-gate") !== GATE_SECRET) throw new Error("fake bridge host: missing gate header");
    if (!headers.get("authorization")?.startsWith("Bearer ")) throw new Error("fake bridge host: missing bearer");
    const rawBody = typeof init.body === "string" ? init.body : undefined;
    const request: RecordedRequest = { method, url, headers, body: rawBody === undefined ? undefined : JSON.parse(rawBody) };
    const path = url.pathname;
    if (method === "GET" && LOGIN_IDS_PATH.test(path)) {
      loginIdLookups.push(request);
      return json({ login_ids: loginIds[path.split("/")[2]!] ?? [] });
    }
    requests.push(request);
    const route = routes.find(candidate => candidate.method === method && candidate.pattern.test(path));
    if (!route) return json({ errcode: "M_UNRECOGNIZED", error: "Unrecognized request" }, 404);
    if (init.signal.aborted) throw init.signal.reason;
    return route.handler(request, init.signal);
  };

  return { fetchImpl, requests, loginIdLookups, loginIds, on };
}

/** Install the Synapse admin and appservice-login endpoints the platform uses to mint a session. */
export function installSynapseAdmin(host: ReturnType<typeof createFakeBridgeHost>, tokens: string[] = []) {
  const users = new Set<string>();
  const devices = new Set<string>();
  let minted = 0;
  host.on("PUT", /^\/_synapse\/admin\/v2\/users\/[^/]+$/, request => {
    const userId = decodeURIComponent(request.url.pathname.split("/").pop()!);
    const created = !users.has(userId);
    users.add(userId);
    return json({ name: userId, admin: false }, created ? 201 : 200);
  });
  host.on("POST", /^\/_matrix\/client\/v3\/login$/, request => {
    const body = request.body as { type: string; identifier: { type: string; user: string }; device_id: string };
    if (request.headers.get("authorization") !== `Bearer ${APPSERVICE_TOKEN}`) return json({ errcode: "M_UNKNOWN_TOKEN", error: "Unknown token" }, 401);
    if (body.type !== "m.login.application_service" || body.identifier.type !== "m.id.user" || !users.has(body.identifier.user)) {
      return json({ errcode: "M_FORBIDDEN", error: "Invalid login" }, 403);
    }
    devices.add(`${body.identifier.user}|${body.device_id}`);
    const token = tokens[minted] ?? `syt_minted_token_${minted}_abcdefghijklmnop`;
    minted += 1;
    return json({ user_id: body.identifier.user, access_token: token, device_id: body.device_id, home_server: SERVER_NAME });
  });
  return { users, devices };
}

/** Resolve after the request's abort signal fires, like a bridge still waiting for a scan. */
export function waitForAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
