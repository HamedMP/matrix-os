import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createOpenMausBotOwnerCheck } from "../../packages/gateway/src/hosted-bots/oss-owner.js";
import { markAuthContextReady, markVerifiedRuntimeBearer, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenMausBotGateway, OPENMAUSBOT_PROXY_BASE } from "../../packages/gateway/src/hosted-bots/oss-gateway.js";

const proxyHeaders = { "x-matrix-hosted-bots-proxy": "1" };

describe("OpenMausBot gateway transport", () => {
  let directory: string;
  let socketPath: string;
  let socketServer: Server;
  let received: { path?: string; headers: IncomingHttpHeaders; body: string }[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "omb-http-"));
    socketPath = join(directory, "http.sock");
    received = [];
    socketServer = createServer(async (req, res) => {
      const body = (await Array.fromAsync(req)).join("");
      received.push({ path: req.url, headers: req.headers, body });
      if (req.url === "/api/health") {
        res.setHeader("content-type", "application/json");
        res.end('{"app":"openmausbot"}');
        return;
      }
      if (req.url === "/api/events?since=boot-id:1") {
        res.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
        const frame = req.headers["last-event-id"] === "boot-id:2" ? "approval" : "hello";
        res.write("id: boot-id:2\ndata: " + frame + "\n\n");
        return;
      }
      if (req.url === "/api/events?ticket=example") {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("x-accel-buffering", "no");
        res.end("data: {\"kind\":\"message\"}\n\n");
        return;
      }
      res.setHeader("content-security-policy", "frame-ancestors 'none'");
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("set-cookie", [
        "omb_session_8799_abc123=omb_sess_fake; Path=/; HttpOnly; Secure; SameSite=Lax",
        "__session=untrusted; Path=/",
      ]);
      res.end("upstream response");
    });
    await new Promise<void>((resolve, reject) => socketServer.once("error", reject).listen(socketPath, resolve));
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  function mount(admitted = true, owner = true, eventsWindowMs?: number) {
    const gateway = createOpenMausBotGateway({ socketPath, admitted, isOwner: () => owner, eventsWindowMs });
    const app = new Hono();
    app.route(OPENMAUSBOT_PROXY_BASE, gateway.routes);
    return { app, gateway };
  }

  it("injects a private model ticket only for an admitted, owner-approved paired text POST", async () => {
    const issueModelTurn = vi.fn(() => "c".repeat(64));
    const base = OPENMAUSBOT_PROXY_BASE + "/api/bots/pebble/messages";
    const body = JSON.stringify({ threadId: "chat", sendId: "send-0123456789abcdef", text: "summarize" });
    const headers = { ...proxyHeaders, "content-type": "application/json",
      "x-matrix-hosted-bots-model-turn": "spoof", "x-matrix-hosted-bots-session": "omb_session_8799_abc123=omb_sess_existing" };
    const send = (admitted: boolean, owner: boolean, requestHeaders: Record<string, string>) => {
      const gateway = createOpenMausBotGateway({ socketPath, admitted, isOwner: () => owner, issueModelTurn });
      const app = new Hono();
      app.route(OPENMAUSBOT_PROXY_BASE, gateway.routes);
      return app.request(base, { method: "POST", headers: requestHeaders, body });
    };
    expect((await send(false, true, headers)).status).toBe(404);
    expect((await send(true, false, headers)).status).toBe(403);
    await (await send(true, true, { ...proxyHeaders, "content-type": "application/json" })).text();
    expect(issueModelTurn).not.toHaveBeenCalled();
    expect(received[0]?.headers).not.toHaveProperty("x-matrix-hosted-bots-model-turn");
    const response = await send(true, true, headers);
    await response.text();
    expect(issueModelTurn).toHaveBeenCalledWith({ botId: "pebble", threadId: "chat", sendId: "send-0123456789abcdef" }, "summarize");
    expect(received[1]?.headers["x-matrix-hosted-bots-model-turn"]).toBe("c".repeat(64));
    expect(response.headers.get("x-matrix-hosted-bots-model-turn")).toBeNull();
  });

  it("exposes only owner readiness from the real Unix HTTP service", async () => {
    expect((await mount(false).app.request(OPENMAUSBOT_PROXY_BASE)).status).toBe(404);
    expect((await mount(true, false).app.request(OPENMAUSBOT_PROXY_BASE)).status).toBe(403);
    expect(received).toHaveLength(0);
    const ready = await mount().app.request(OPENMAUSBOT_PROXY_BASE);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });
    expect(received[0]?.path).toBe("/api/health");
    const home = await mount().app.request(OPENMAUSBOT_PROXY_BASE + "/", { headers: proxyHeaders });
    expect(await home.text()).toBe("upstream response");
    expect(received[1]?.path).toBe("/");
  });

  it("reports an installed but starting OSS service as unavailable without signaling fallback", async () => {
    const gateway = createOpenMausBotGateway({
      socketPath: join(directory, "not-started.sock"),
      admitted: true,
      isOwner: () => true,
    });
    const response = await gateway.routes.request("/");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("preserves upstream pairing and CSP without forwarding Matrix or loopback credentials", async () => {
    const { app } = mount();
    const path = OPENMAUSBOT_PROXY_BASE + "/api/auth/pair";
    const data = '{"code":"synthetic-only"}';
    const response = await app.request(path, {
      method: "POST", body: data, headers: {
        ...proxyHeaders, authorization: "Bearer matrix-token", origin: "https://app.matrix-os.com",
        cookie: "__session=matrix-cookie; omb_session_8799_abc123=omb_sess_ignored",
        "x-matrix-hosted-bots-session": "omb_session_8799_abc123=omb_sess_existing",
        "content-type": "application/json", "x-openmausbot-cli-owner": "fake", "x-forwarded-for": "1.2.3.4",
      },
    });
    expect(response.status).toBe(200);
    expect(received[0]).toMatchObject({
      path: "/api/auth/pair", body: data,
      headers: { host: "matrix-bots.invalid", origin: "https://matrix-bots.invalid", cookie: "omb_session_8799_abc123=omb_sess_existing" },
    });
    for (const name of ["authorization", "x-forwarded-for", "x-openmausbot-cli-owner", "x-matrix-hosted-bots-proxy"]) {
      expect(received[0]?.headers).not.toHaveProperty(name);
    }
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("x-matrix-hosted-bots-set-session")).toBe("omb_session_8799_abc123=omb_sess_fake; Path=/; HttpOnly; Secure; SameSite=Lax");
  });

  it("closes a sparse SSE window cleanly before the Platform deadline and relays the reconnect cursor", async () => {
    const { app } = mount(true, true, 200);
    const path = OPENMAUSBOT_PROXY_BASE + "/api/events?since=boot-id:1";
    const first = await app.request(path, { headers: proxyHeaders, signal: AbortSignal.timeout(1_500) });
    expect(first.headers.get("x-accel-buffering")).toBe("no");
    const reader = first.body!.getReader();
    const frame = await reader.read();
    expect(frame.done).toBe(false);
    expect(new TextDecoder().decode(frame.value)).toBe("id: boot-id:2\ndata: hello\n\n");
    expect((await reader.read()).done).toBe(true);
    const resumed = await app.request(path, {
      headers: { ...proxyHeaders, "last-event-id": "boot-id:2" }, signal: AbortSignal.timeout(1_500),
    });
    expect(await resumed.text()).toBe("id: boot-id:2\ndata: approval\n\n");
    expect(received.map((request) => request.headers["last-event-id"])).toEqual([undefined, "boot-id:2"]);
  });

  it("passes the SSE stream but blocks direct document navigation and bootstrap or internal paths", async () => {
    const { app } = mount();
    expect((await app.request(OPENMAUSBOT_PROXY_BASE + "/assets/index.js")).status).toBe(403);
    expect((await app.request(OPENMAUSBOT_PROXY_BASE + "/pair", { headers: { ...proxyHeaders, "sec-fetch-mode": "navigate" } })).status).toBe(403);
    expect((await app.request(OPENMAUSBOT_PROXY_BASE + "/api/internal/foo", { headers: proxyHeaders })).status).toBe(404);
    expect((await app.request(OPENMAUSBOT_PROXY_BASE + "/pairing", { headers: proxyHeaders })).status).toBe(404);
    expect((await app.request(OPENMAUSBOT_PROXY_BASE + "/api/sync/changes", { headers: proxyHeaders })).status).toBe(404);
    expect((await app.request(OPENMAUSBOT_PROXY_BASE + "/api/x/status", { headers: proxyHeaders, method: "POST" })).status).toBe(405);
    expect(received).toHaveLength(0);
    const stream = await app.request(OPENMAUSBOT_PROXY_BASE + "/api/events?ticket=example", {
      headers: { ...proxyHeaders, "last-event-id": "boot-id:12" },
    });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(stream.headers.get("x-accel-buffering")).toBe("no");
    expect(stream.headers.get("cache-control")).toContain("no-transform");
    expect(received[0]?.headers["last-event-id"]).toBe("boot-id:12");
    expect(await stream.text()).toContain('"kind":"message"');
  });
});

it("admits only a verified owner actor through the regular Computer gateway", async () => {
  const owner = "user_a";
  const token = "test-runtime-bearer";
  const app = new Hono();
  const check = createOpenMausBotOwnerCheck({ MATRIX_CLERK_USER_ID: owner, MATRIX_USER_ID: owner });
  app.use("*", authMiddleware(token));
  app.get(OPENMAUSBOT_PROXY_BASE, c => c.json({ allowed: check(c) }));
  const auth = { authorization: "Bearer " + token };
  const proof = (actor: string) => ({
    ...auth,
    "x-platform-user-id": actor,
    "x-platform-verified": createHmac("sha256", token).update(actor).digest("hex"),
  });
  for (const [headers, allowed] of [
    [proof(owner), true],
    [proof("delegated_user"), false],
    [auth, false],
    [{ ...auth, "x-platform-user-id": owner, "x-platform-verified": "forged" }, false],
  ] as const) {
    const response = await app.request(OPENMAUSBOT_PROXY_BASE, { headers });
    expect(await response.json()).toEqual({ allowed });
  }
});

it("checks verified Matrix owner identity independently of OpenMausBot pairing", async () => {
  async function verify(env: NodeJS.ProcessEnv, actor: string, verified = true) {
    const check = createOpenMausBotOwnerCheck(env);
    const app = new Hono();
    app.get("/", (c) => {
      markAuthContextReady(c);
      if (verified) markVerifiedRuntimeBearer(c);
      setPlatformVerifiedPrincipal(c, actor);
      return c.json({ allowed: check(c) });
    });
    return (await app.request("/")).json();
  }

  const env = { MATRIX_CLERK_USER_ID: "user_a", MATRIX_USER_ID: "user_a" };
  expect(await verify(env, "user_a")).toEqual({ allowed: true });
  expect(await verify(env, "user_b")).toEqual({ allowed: false });
  expect(await verify(env, "user_a", false)).toEqual({ allowed: false });
  expect(await verify({ ...env, MATRIX_USER_ID: "user_b" }, "user_a")).toEqual({ allowed: false });
});
