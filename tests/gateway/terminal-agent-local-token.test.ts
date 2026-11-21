import { lstat, mkdtemp, readFile, rm, stat, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import {
  createLocalTerminalAgentToken,
  isLocalTerminalAgentRoute,
} from "../../packages/gateway/src/terminal-agent/local-token.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function home() {
  const path = await mkdtemp(join(tmpdir(), "matrix-local-token-"));
  homes.push(path);
  return path;
}

const WS = `tws_${"0".repeat(32)}`;
const TAB = `tt_${"1".repeat(32)}`;
const LOCAL = "c".repeat(64);

function app() {
  const server = new Hono();
  server.use("*", authMiddleware("owner-runtime-token-that-is-long", { localTerminalAgentToken: () => LOCAL }));
  server.all("*", (c) => c.json({ ok: true }));
  return server;
}

function call(path: string, init: { method?: string; token?: string; headers?: Record<string, string>; peer?: string } = {}) {
  return app().request(path, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${init.token ?? LOCAL}`, ...init.headers },
  }, { incoming: { socket: { remoteAddress: init.peer ?? "127.0.0.1" } } });
}

// Fault detected (live test on the #3300 preview): agents in a Matrix terminal had no way
// to reach the gateway, so Herdr-style helpers could not be run from inside a terminal.
describe("local terminal-agent token", () => {
  it("is written owner-only, atomically, and replaced on every start", async () => {
    const path = await home();
    const first = await createLocalTerminalAgentToken({ homePath: path });
    const file = join(path, ".cache", "matrix", "terminal-agent.token");
    expect((await readFile(file, "utf8")).trim()).toBe(first.token);
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".cache", "matrix"))).mode & 0o777).toBe(0o700);
    const second = await createLocalTerminalAgentToken({ homePath: path });
    expect(second.token).not.toBe(first.token);
    expect((await readFile(file, "utf8")).trim()).toBe(second.token);
    await second.close();
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlinked token directory", async () => {
    const path = await home();
    const elsewhere = await home();
    await mkdir(join(path, ".cache"), { recursive: true });
    await symlink(elsewhere, join(path, ".cache", "matrix"));
    await expect(createLocalTerminalAgentToken({ homePath: path })).rejects.toThrow();
  });

  it("opens only the terminal-agent routes, only from a direct loopback caller", async () => {
    expect((await call(`/api/terminal/workspaces/${WS}/tabs/${TAB}/read`)).status).toBe(200);
    expect((await call("/api/terminal/agents/run", { method: "POST" })).status).toBe(200);
    expect((await call("/api/terminal/workspaces")).status).toBe(200);
    expect((await call("/api/files/list")).status).toBe(401);
    expect((await call(`/api/terminal/workspaces/${WS}/tabs/${TAB}/read`, { peer: "10.0.0.5" })).status).toBe(401);
    expect((await call(`/api/terminal/workspaces/${WS}/tabs/${TAB}/read`, { headers: { "x-real-ip": "203.0.113.9" } })).status).toBe(401);
    expect((await call(`/api/terminal/workspaces/${WS}/tabs/${TAB}/read`, { token: "d".repeat(64) })).status).toBe(401);
  });

  it("lists exactly the routes an agent uses", () => {
    expect(isLocalTerminalAgentRoute("GET", "/api/terminal/templates")).toBe(true);
    expect(isLocalTerminalAgentRoute("GET", "/api/coding-agents/summary")).toBe(true);
    expect(isLocalTerminalAgentRoute("POST", "/api/terminal/workspaces/ensure")).toBe(true);
    expect(isLocalTerminalAgentRoute("POST", `/api/terminal/workspaces/${WS}/tabs`)).toBe(false);
    expect(isLocalTerminalAgentRoute("POST", `/api/terminal/workspaces/${WS}/tabs/${TAB}/send`)).toBe(true);
    expect(isLocalTerminalAgentRoute("DELETE", `/api/terminal/workspaces/${WS}/tabs/${TAB}`)).toBe(false);
    expect(isLocalTerminalAgentRoute("POST", `/api/terminal/workspaces/${WS}/tabs/${TAB}/../../files`)).toBe(false);
    expect(isLocalTerminalAgentRoute("GET", "/api/terminal/preferences")).toBe(false);
  });
});
