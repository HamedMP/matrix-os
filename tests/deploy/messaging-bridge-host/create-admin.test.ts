import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLE_DIR } from "./helpers.js";

const SCRIPT = join(BUNDLE_DIR, "lib/create-admin.py");
const SECRET = "s".repeat(64);
const PASSWORD = "p".repeat(64);
const NONCE = "nonce-123";

interface Seen {
  method: string;
  path: string;
  auth?: string;
  body: Record<string, unknown>;
}

type Mode = "fresh" | "existing" | "rejected";

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
  });
}

function fakeSynapse(mode: Mode, seen: Seen[]): Promise<Server> {
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body });
    if (req.method === "GET" && req.url === "/_synapse/admin/v1/register") return reply(res, 200, { nonce: NONCE });
    if (req.method === "POST" && req.url === "/_synapse/admin/v1/register") {
      const expected = createHmac("sha1", SECRET)
        .update([NONCE, "mxadmin", PASSWORD, "admin"].join("\x00"))
        .digest("hex");
      if (body.mac !== expected) return reply(res, 403, { errcode: "M_FORBIDDEN" });
      if (mode === "existing") return reply(res, 400, { errcode: "M_USER_IN_USE" });
      if (mode === "rejected") return reply(res, 400, { errcode: "M_UNKNOWN", error: "internal detail" });
      return reply(res, 200, { access_token: "tok-registered", user_id: "@mxadmin:bridge.test", device_id: "D1" });
    }
    if (req.method === "POST" && req.url === "/_matrix/client/v3/login") {
      return reply(res, 200, { access_token: "tok-login", user_id: "@mxadmin:bridge.test", device_id: "D2" });
    }
    if (req.method === "POST" && req.url?.startsWith("/_synapse/admin/v1/users/")) return reply(res, 200, {});
    return reply(res, 404, { errcode: "M_UNRECOGNIZED" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function runScript(port: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-I", SCRIPT], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MBH_SYNAPSE_URL: `http://127.0.0.1:${port}` },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ localpart: "mxadmin", password: PASSWORD, shared_secret: SECRET }));
  });
}

describe("lib/create-admin.py", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it("registers the admin with a valid shared-secret MAC and lifts its rate limit", async () => {
    const seen: Seen[] = [];
    server = await fakeSynapse("fresh", seen);
    const run = await runScript((server.address() as AddressInfo).port);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("tok-registered\n");
    const register = seen.find((call) => call.method === "POST" && call.path === "/_synapse/admin/v1/register");
    expect(register?.body).toMatchObject({ nonce: NONCE, username: "mxadmin", admin: true });
    const override = seen.at(-1);
    expect(override?.path).toBe("/_synapse/admin/v1/users/%40mxadmin%3Abridge.test/override_ratelimit");
    expect(override?.auth).toBe("Bearer tok-registered");
    expect(override?.body).toEqual({ messages_per_second: 0, burst_count: 0 });
  });

  it("logs in instead when a previous run already created the admin", async () => {
    const seen: Seen[] = [];
    server = await fakeSynapse("existing", seen);
    const run = await runScript((server.address() as AddressInfo).port);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("tok-login\n");
    const login = seen.find((call) => call.path === "/_matrix/client/v3/login");
    expect(login?.body).toMatchObject({ type: "m.login.password", identifier: { type: "m.id.user", user: "mxadmin" } });
  });

  it("fails without a token and reports only the error code", async () => {
    const seen: Seen[] = [];
    server = await fakeSynapse("rejected", seen);
    const run = await runScript((server.address() as AddressInfo).port);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("M_UNKNOWN");
    expect(run.stderr).not.toContain("internal detail");
    expect(run.stderr).not.toContain(PASSWORD);
    expect(run.stderr).not.toContain(SECRET);
  });
});
