import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  createOrAttachRunSession,
  parseRunCommand,
  quoteCommandArg,
  runCommand,
} from "../../packages/sync-client/src/cli/commands/run.js";
import { PUBLISHED_CLI_COMMANDS, resolvePublishedCliRedirect } from "../../packages/cli/src/index.js";

async function createFakeRunGateway() {
  let createRequests = 0;
  let wsConnections = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/terminal/sessions") {
      createRequests += 1;
      req.resume();
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "run-session", created: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  const wss = new WebSocketServer({ server, path: "/ws/terminal/session" });
  wss.on("connection", (ws) => {
    wsConnections += 1;
    ws.send(JSON.stringify({ type: "attached" }));
    setTimeout(() => ws.close(), 10).unref?.();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake gateway did not bind a TCP port");
  }

  return {
    gatewayUrl: `http://127.0.0.1:${address.port}`,
    get createRequests() {
      return createRequests;
    },
    get wsConnections() {
      return wsConnections;
    },
    async close() {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function runMatrixCli(args: string[]) {
  const home = await mkdtemp(join(tmpdir(), "matrix-run-cli-"));
  const bin = join(process.cwd(), "packages/sync-client/bin/matrix.mjs");
  try {
    return await new Promise<{
      status: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, FORCE_COLOR: "0", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (err) => {
        reject(err);
      });
      child.on("close", (status, signal) => {
        resolve({
          status,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("run CLI command", () => {
  it("exports the developer run command", () => {
    expect(runCommand.meta?.name).toBe("run");
    expect(PUBLISHED_CLI_COMMANDS.has("run")).toBe(true);
    expect(resolvePublishedCliRedirect(["run", "-it", "--", "claude"])).toEqual([
      "run",
      "-it",
      "--",
      "claude",
    ]);
  });

  it("parses command argv after -- without treating Matrix flags as remote command args", () => {
    expect(parseRunCommand(["-it", "--session", "setup", "-C", "projects/app", "--", "gh", "auth", "login"])).toEqual([
      "gh",
      "auth",
      "login",
    ]);
    expect(parseRunCommand(["-it", "--cwd", "projects/app", "pnpm", "test"])).toEqual(["pnpm", "test"]);
    expect(parseRunCommand(["-it", "--cwd=projects/app", "pnpm", "test"])).toEqual(["pnpm", "test"]);
    expect(parseRunCommand(["-it", "--session=setup", "claude"])).toEqual(["claude"]);
  });

  it("attaches existing named sessions instead of failing create-or-attach", async () => {
    const client = {
      createSession: vi.fn(async () => {
        throw Object.assign(new Error("Request failed"), { code: "session_exists" });
      }),
      attachSession: vi.fn(async () => ({ detached: true })),
    };

    await expect(
      createOrAttachRunSession(client, {
        name: "setup",
        command: ["claude"],
        sessionProvided: true,
      }),
    ).resolves.toEqual({ detached: true });
    expect(client.attachSession).toHaveBeenCalledWith("setup", {});
  });

  it("passes no-mouse mode through interactive run attach", async () => {
    const client = {
      createSession: vi.fn(async () => ({ name: "setup" })),
      attachSession: vi.fn(async () => ({ detached: true })),
    };

    await expect(
      createOrAttachRunSession(client, {
        name: "setup",
        command: ["claude"],
        sessionProvided: true,
        mouse: false,
      }),
    ).resolves.toEqual({ detached: true });
    expect(client.attachSession).toHaveBeenCalledWith("setup", { mouse: false });
  });

  it("keeps stdout JSON-only for run -it --json", async () => {
    const gateway = await createFakeRunGateway();
    try {
      const result = await runMatrixCli([
        "run",
        "-it",
        "--session",
        "run-session",
        "--gateway",
        gateway.gatewayUrl,
        "--token",
        "tok",
        "--json",
        "--",
        "echo",
        "ok",
      ]);

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).not.toContain("\u001b[");
      expect(JSON.parse(result.stdout)).toEqual({
        v: 1,
        ok: true,
        data: { detached: true, session: "run-session" },
      });
      expect(result.stderr).toContain("\u001b[?1000l");
      expect(gateway.createRequests).toBe(1);
      expect(gateway.wsConnections).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it("does not reuse an accidental ephemeral session collision", async () => {
    const client = {
      createSession: vi.fn(async () => {
        throw Object.assign(new Error("Request failed"), { code: "session_exists" });
      }),
      attachSession: vi.fn(async () => ({ detached: true })),
    };

    await expect(
      createOrAttachRunSession(client, {
        name: "run-collision",
        command: ["claude"],
        sessionProvided: false,
      }),
    ).rejects.toMatchObject({ code: "session_exists" });
    expect(client.attachSession).not.toHaveBeenCalled();
  });

  it("quotes remote argv so shell sessions preserve spaces and single quotes", () => {
    expect(["gh", "auth", "login"].map(quoteCommandArg).join(" ")).toBe("gh auth login");
    expect(["echo", "hello world", "it's ok"].map(quoteCommandArg).join(" ")).toBe(
      "echo 'hello world' 'it'\\''s ok'",
    );
  });
});
