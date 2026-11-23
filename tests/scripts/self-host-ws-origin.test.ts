import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { registerHerdrTerminalWebSocket } from "../../packages/gateway/src/herdr/ws.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createGatewayAllowedOriginController } from "../../packages/gateway/src/server/browser-setup-origin.js";
import { registerWebSocketOriginGate, resolveWebSocketOriginPolicy } from "../../packages/gateway/src/server/websocket-origin-gate.js";
import { createTerminalLiveOwnership } from "../../packages/gateway/src/terminal-live-ownership.js";
import { createFakeHerdrCore } from "../gateway/fixtures/fake-herdr-core-server.js";

// Fault detected: the self-host ingress adds the owner's credentials to every
// /ws request (the tailnet identity plus the runtime bearer, or cached Basic
// Auth), so a page on another site opened in the owner's browser could attach
// to a terminal, read it and type. Covers what the installer writes, the nginx
// site it renders, and the gateway behind it.
const root = process.cwd();
const script = join(root, "scripts/install-server.sh");
const OWNER = "self-host-owner";
const TOKEN = "s".repeat(48);
const savedEnv = { ...process.env };
const cleanup: Array<() => Promise<void> | void> = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matrix-ws-origin-"));
  process.env.MATRIX_AUTH_TOKEN = TOKEN;
  process.env.MATRIX_USER_ID = OWNER;
  delete process.env.MATRIX_HANDLE;
  delete process.env.MATRIX_RUNTIME_SLOT;
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  process.env = { ...savedEnv };
  rmSync(dir, { recursive: true, force: true });
});

function installer(body: string, path = process.env.PATH ?? "/usr/bin:/bin") {
  const result = spawnSync("bash", ["-c", `set -Eeuo pipefail\nsource "$INSTALLER"\n${body}`], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: path, HOME: process.env.HOME ?? "/tmp", INSTALLER: script,
      MATRIX_INSTALL_SOURCE_ONLY: "1", MATRIX_INSTALL_NONINTERACTIVE: "1", MATRIX_INSTALL_COLOR: "never", MATRIX_NO_TELEMETRY: "1",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/** The gateway environment the installer writes for a private access mode, with serve answering `https`. */
function installedEnv(access: "tailscale" | "headscale", https: boolean): NodeJS.ProcessEnv {
  const bin = join(dir, `bin-${access}-${https}`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tailscale"), `#!/bin/sh\ncase "$*" in *--https=443*) exit ${https ? 0 : 1} ;; esac\nexit 0\n`);
  chmodSync(join(bin, "tailscale"), 0o755);
  const dns = access === "headscale" ? "box.hs.example" : "box.tail1.ts.net";
  const out = installer(`MATRIX_INSTALL_LOG=/dev/null; OPT_ACCESS=${access}
MATRIX_TAILNET_URL=$([ "$OPT_ACCESS" = headscale ] && echo http://${dns} || echo https://${dns})
configure_tailscale_serve >/dev/null 2>&1
printf 'MATRIX_ACCESS_MODE=%s\\nMATRIX_TAILNET_URL=%s\\nSHELL_ORIGIN=%s\\n' "$OPT_ACCESS" "$MATRIX_TAILNET_URL" "$(self_host_shell_origin "$OPT_ACCESS" "$MATRIX_TAILNET_URL" '')"`,
  `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`);
  const env: NodeJS.ProcessEnv = { MATRIX_SELF_HOSTED: "1" };
  for (const line of out.trim().split("\n")) {
    const [key, ...value] = line.split("=");
    env[key!] = value.join("=");
  }
  return env;
}

describe("self-host WebSocket origins: installer to gateway", () => {
  it("writes the access mode, tailnet URL and shell origin the gateway's Origin check reads", () => {
    const writeEnv = readFileSync(script, "utf8").split("\nwrite_env() {")[1]!.split("\n}\n")[0]!;
    expect(writeEnv).toContain("MATRIX_SELF_HOSTED=1");
    expect(writeEnv).toContain("MATRIX_ACCESS_MODE=${OPT_ACCESS}");
    expect(writeEnv).toContain("MATRIX_TAILNET_URL=${MATRIX_TAILNET_URL}");
    expect(writeEnv).toContain(`printf 'SHELL_ORIGIN=%s\\n' "$shell_origin" >>/opt/matrix/env/host.env`);
  });

  it.each([
    ["tailscale", true, "https://box.tail1.ts.net"],
    ["tailscale", false, "http://box.tail1.ts.net"],
    ["headscale", false, "http://box.hs.example"],
  ] as const)("%s (https serve %s): the gateway accepts the tailnet origin on both schemes and refuses others", (access, https, shell) => {
    const env = installedEnv(access, https);
    expect(env.SHELL_ORIGIN).toBe(shell);
    const policy = resolveWebSocketOriginPolicy(env, createGatewayAllowedOriginController(env));
    expect(policy.enforce).toBe(true);
    const host = new URL(shell).host;
    // The printed link, and its other scheme once certificates are turned on or off later.
    expect(policy.isAllowed(`https://${host}`)).toBe(true);
    expect(policy.isAllowed(`http://${host}`)).toBe(true);
    for (const foreign of ["https://untrusted.example", "null", `https://${host}.evil.example`, `https://evil.${host}`]) {
      expect(policy.isAllowed(foreign), foreign).toBe(false);
    }
  });

  it("renders the public site with a same-host Origin check on every WebSocket upgrade, private sites without one", () => {
    const publicSite = installer(`render_nginx_site public _ /etc/nginx/matrix-self-host.htpasswd off`);
    expect(publicSite).toContain(`map "$http_upgrade|$http_origin|$http_host" $matrix_ws_origin_ok {`);
    expect(publicSite).toContain("if ($matrix_ws_origin_ok = 0) { return 403; }");
    const privateSite = installer(`render_nginx_site tailscale _ /etc/nginx/matrix-self-host.htpasswd on`);
    expect(privateSite).not.toContain("matrix_ws_origin_ok");
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** The production gateway pieces behind the ingress: Origin gate, bearer auth, the Herdr socket. */
async function gateway(env: NodeJS.ProcessEnv, ownerLogin?: string) {
  const core = createFakeHerdrCore();
  core.add("t1", { screen: "owner secrets" });
  const adapter = createHerdrAdapter({ open: async () => core.connect(), captureQuietMs: 5, captureMaxMs: 100 });
  cleanup.push(() => adapter.close());
  const app = new Hono();
  const ws = createNodeWebSocket({ app });
  const ownership = createTerminalLiveOwnership();
  cleanup.push(() => ownership.close());
  registerWebSocketOriginGate(app, resolveWebSocketOriginPolicy(env, createGatewayAllowedOriginController(env)));
  app.use("*", authMiddleware(TOKEN));
  // The owner identity check nginx asks before every private request (layer 5 implements it).
  // With ownerLogin, it answers like the real check: only that exact login passes.
  app.get("/api/system/private-network/identity", (c) => (ownerLogin === undefined || c.req.header("tailscale-user-login") === ownerLogin
    ? c.json({ ok: true }) : c.json({ error: "Forbidden" }, 403)));
  const viewers = registerHerdrTerminalWebSocket({
    app, upgradeWebSocket: ws.upgradeWebSocket, adapter, getPrincipal: (c) => requireRequestPrincipal(c),
    terminalOwnerIds: [OWNER], terminalLiveOwnership: ownership,
  });
  cleanup.push(() => viewers.drain());
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  ws.injectWebSocket(server);
  if (!server.listening) await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  return { core, port: address.port };
}

/** The installer's nginx site, on a free loopback port in front of the test gateway. */
async function ingress(access: "public" | "tailscale", gatewayPort: number): Promise<number> {
  const port = await freePort();
  tailnetSocket = join(dir, "tailnet.sock");
  const htpasswd = join(dir, "htpasswd");
  writeFileSync(htpasswd, "owner:{PLAIN}pass\n");
  const site = installer(`render_nginx_site ${access} _ ${htpasswd} off`)
    .replace(/listen (127\.0\.0\.1:)?80 default_server;/, `listen 127.0.0.1:${port};`)
    .replace("listen unix:/run/matrix-nginx/tailnet.sock;", `listen unix:${tailnetSocket};`)
    .replaceAll("include /opt/matrix/env/gateway-auth-token.conf;", `proxy_set_header Authorization "Bearer ${TOKEN}";`)
    .replaceAll("127.0.0.1:4000", `127.0.0.1:${gatewayPort}`);
  writeFileSync(join(dir, "site.conf"), site);
  writeFileSync(join(dir, "nginx.conf"), `pid ${dir}/nginx.pid; error_log ${dir}/error.log; events { worker_connections 32; }
http { access_log off; client_body_temp_path ${dir}/body; proxy_temp_path ${dir}/proxy; include ${dir}/site.conf; }`);
  const child: ChildProcess = spawn("/usr/sbin/nginx", ["-p", dir, "-c", join(dir, "nginx.conf"), "-g", "daemon off; master_process off;"], { stdio: "ignore" });
  cleanup.push(() => { child.kill("SIGTERM"); });
  const start = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`nginx exited: ${existsSync(join(dir, "error.log")) ? readFileSync(join(dir, "error.log"), "utf8") : ""}`);
    const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok, () => false);
    if (ok) return port;
    if (Date.now() - start > 5_000) throw new Error("nginx did not start");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let tailnetSocket = "";
/** `port` is nginx's loopback listener; "tailnet" is the Tailscale Serve socket. */
function connect(port: number | "tailnet", headers: Record<string, string>) {
  const target = port === "tailnet" ? `ws+unix://${tailnetSocket}:/ws/terminal/herdr?id=t1&lease=exclusive` : `ws://127.0.0.1:${port}/ws/terminal/herdr?id=t1&lease=exclusive`;
  const socket = new WebSocket(target, { headers });
  const frames: Array<Record<string, unknown>> = [];
  let status: number | null = null;
  let done = false;
  socket.on("message", (data) => { frames.push(JSON.parse(String(data))); });
  socket.on("unexpected-response", (_request, response) => { status = response.statusCode ?? null; socket.terminate(); done = true; });
  socket.on("error", () => { done = true; });
  socket.on("close", () => { done = true; });
  cleanup.push(() => { if (!done) socket.terminate(); });
  return {
    frames,
    status: () => status,
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    async until(check: () => boolean) {
      const start = Date.now();
      while (!check()) {
        if (Date.now() - start > 3_000) throw new Error(`timed out; status ${status}; frames ${JSON.stringify(frames)}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

// The real nginx is on production hosts and developer machines; generic CI
// runners without it still run the installer-to-gateway cases above.
const nginxIt = existsSync("/usr/sbin/nginx") ? it : it.skip;

describe("self-host WebSocket origins: through the rendered nginx site", () => {
  nginxIt("private mode: the tailnet shell attaches and types, a foreign page is refused, the CLI still connects", async () => {
    const env = installedEnv("tailscale", true);
    const { core, port: gatewayPort } = await gateway(env);
    const port = await ingress("tailscale", gatewayPort);
    // The page supplies no credential: nginx adds the owner's bearer to every /ws request.
    const foreign = connect(port, { Origin: "https://untrusted.example" });
    await foreign.until(() => foreign.status() !== null);
    expect(foreign.status()).toBe(403);
    expect(foreign.frames).toEqual([]);
    expect(core.viewers).toEqual([]);

    const shell = connect(port, { Origin: "https://box.tail1.ts.net" });
    await shell.until(() => shell.frames.some((frame) => frame.type === "output"));
    expect(shell.frames[0]).toMatchObject({ type: "attached", ownership: "writer" });
    shell.send({ type: "input", terminalRef: shell.frames[0]!.terminalRef, data: "ls\r" });
    await shell.until(() => core.terminals.get("t1")!.input.length === 1);
    expect(core.terminals.get("t1")!.input).toEqual(["ls\r"]);

    const cli = connect(port, {});
    await cli.until(() => cli.frames.some((frame) => frame.type === "attached"));
  });

  // Found in review: any local account (the browser account included) could send
  // the owner's Tailscale login to nginx on loopback and get the owner's bearer.
  nginxIt("private mode: a tailnet identity counts only through the Tailscale Serve socket", async () => {
    const env = installedEnv("tailscale", true);
    const { core, port: gatewayPort } = await gateway(env, "alice@example.com");
    const port = await ingress("tailscale", gatewayPort);
    const owner = { "Tailscale-User-Login": "alice@example.com", Origin: "https://box.tail1.ts.net" };
    const forged = connect(port, owner);
    await forged.until(() => forged.status() !== null);
    expect(forged.status()).toBe(403);
    expect(core.viewers).toEqual([]);
    const anonymous = connect(port, { Origin: "https://box.tail1.ts.net" });
    await anonymous.until(() => anonymous.status() !== null);
    expect(anonymous.status()).toBe(403);
    const served = connect("tailnet", owner);
    await served.until(() => served.frames.some((frame) => frame.type === "attached"));
    expect(served.frames[0]).toMatchObject({ type: "attached", ownership: "writer" });
  });

  nginxIt("public mode: a same-host page attaches, a foreign page carrying cached Basic Auth is refused", async () => {
    const env: NodeJS.ProcessEnv = { MATRIX_SELF_HOSTED: "1", MATRIX_ACCESS_MODE: "public" };
    const { core, port: gatewayPort } = await gateway(env);
    const port = await ingress("public", gatewayPort);
    const basic = { Authorization: `Basic ${Buffer.from("owner:pass").toString("base64")}` };
    const foreign = connect(port, { ...basic, Origin: "https://untrusted.example" });
    await foreign.until(() => foreign.status() !== null);
    expect(foreign.status()).toBe(403);
    expect(core.viewers).toEqual([]);
    const lookalike = connect(port, { ...basic, Origin: `http://127.0.0.1:${port}.evil.example` });
    await lookalike.until(() => lookalike.status() !== null);
    expect(lookalike.status()).toBe(403);

    const same = connect(port, { ...basic, Origin: `http://127.0.0.1:${port}` });
    await same.until(() => same.frames.some((frame) => frame.type === "output"));
    expect(same.frames.find((frame) => frame.type === "output")).toMatchObject({ data: "owner secrets" });
    const cli = connect(port, basic);
    await cli.until(() => cli.frames.some((frame) => frame.type === "attached"));
    const anonymous = connect(port, { Origin: `http://127.0.0.1:${port}` });
    await anonymous.until(() => anonymous.status() !== null);
    expect(anonymous.status()).toBe(401);
  });
});
