import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  createOrAttachRunSession,
  exitCodeFromRunResult,
  inferRunAgent,
  parseRunCommand,
  quoteCommandArg,
  runCommand,
} from "../../packages/sync-client/src/cli/commands/run.js";
import { PUBLISHED_CLI_COMMANDS, resolvePublishedCliRedirect } from "../../packages/cli/src/index.js";

async function createFakeRunGateway(runResult: Record<string, unknown> = {
  stdout: "file.txt\n",
  stderr: "warn\n",
  exitCode: 7,
  signal: null,
  timedOut: false,
  truncated: false,
  durationMs: 8,
}) {
  let createRequests = 0;
  let runRequests: unknown[] = [];
  let wsConnections = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/terminal/sessions") {
      createRequests += 1;
      req.resume();
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "run-session", created: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/terminal/run") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        runRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(runResult));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  const wss = new WebSocketServer({ server, path: "/ws/terminal/session" });
  wss.on("connection", (ws) => {
    wsConnections += 1;
    ws.send(JSON.stringify({ type: "attached" }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "exit" }));
      ws.close();
    }, 10).unref?.();
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
    get runRequests() {
      return runRequests;
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
        env: {
          ...process.env,
          HOME: home,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          NODE_NO_WARNINGS: "1",
        },
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
    expect(runCommand.args).toHaveProperty("noRichPaste");
    expect(runCommand.args).not.toHaveProperty("t");
    expect(runCommand.args).toMatchObject({
      tty: {
        type: "boolean",
        alias: "t",
        description: "Request a TTY; combine with -i as -it",
      },
    });
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
    expect(parseRunCommand(["--tty", "--", "claude"])).toEqual(["claude"]);
  });

  it("shows the standard -t and --tty flags in help", async () => {
    const result = await runMatrixCli(["run", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/-t, --tty/);
    expect(result.stdout).not.toMatch(/\s--t(?:\s|$)/m);
  });

  it("infers agents behind env and inline environment assignments", () => {
    expect(inferRunAgent(["env", "FOO=bar", "claude"])).toBe("claude");
    expect(inferRunAgent(["DEBUG=1", "/opt/matrix/runtime/node/bin/codex"])).toBe("codex");
    expect(inferRunAgent(["env", "FOO=bar", "bash"])).toBeUndefined();
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

  it("maps timed-out runs to 124 even when the remote process reports an exit code", () => {
    expect(exitCodeFromRunResult({ exitCode: 0, timedOut: true })).toBe(124);
    expect(exitCodeFromRunResult({ exitCode: 7, timedOut: false })).toBe(7);
    expect(exitCodeFromRunResult({ exitCode: null, timedOut: false })).toBe(1);
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
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude" }));
  });

  it("passes no-rich-paste mode through interactive run attach", async () => {
    const client = {
      createSession: vi.fn(async () => ({ name: "setup" })),
      attachSession: vi.fn(async () => ({ detached: true })),
    };

    await expect(
      createOrAttachRunSession(client, {
        name: "setup",
        cwd: "projects/app",
        command: ["codex"],
        sessionProvided: true,
        attachOptions: { cwd: "projects/app", noRichPaste: true },
      }),
    ).resolves.toEqual({ detached: true });
    expect(client.attachSession).toHaveBeenCalledWith("setup", { cwd: "projects/app", noRichPaste: true });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex" }));
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
        data: { detached: false, session: "run-session" },
      });
      expect(result.stderr).toContain("\u001b[?1000l");
      expect(gateway.createRequests).toBe(1);
      expect(gateway.wsConnections).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it("runs non-interactive commands and exits with the remote status", async () => {
    const gateway = await createFakeRunGateway();
    try {
      const result = await runMatrixCli([
        "run",
        "--gateway",
        gateway.gatewayUrl,
        "--token",
        "tok",
        "-C",
        "projects/app",
        "--",
        "ls",
      ]);

      expect(result.status).toBe(7);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe("file.txt\n");
      expect(result.stderr).toBe("warn\n");
      expect(gateway.runRequests).toEqual([{ command: ["ls"], cwd: "projects/app" }]);
      expect(gateway.createRequests).toBe(0);
      expect(gateway.wsConnections).toBe(0);
    } finally {
      await gateway.close();
    }
  });

  it("warns when non-interactive text output is truncated", async () => {
    const gateway = await createFakeRunGateway({
      stdout: "partial\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: true,
      durationMs: 8,
    });
    try {
      const result = await runMatrixCli([
        "run",
        "--gateway",
        gateway.gatewayUrl,
        "--token",
        "tok",
        "--",
        "cat",
        "large.log",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("partial\n");
      expect(result.stderr).toBe("matrix: output truncated (limit reached)\n");
    } finally {
      await gateway.close();
    }
  });

  it("rejects --session without interactive mode", async () => {
    const gateway = await createFakeRunGateway();
    try {
      const result = await runMatrixCli([
        "run",
        "--session",
        "setup",
        "--gateway",
        gateway.gatewayUrl,
        "--token",
        "tok",
        "--",
        "ls",
      ]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--session is only supported with -it");
      expect(gateway.runRequests).toEqual([]);
      expect(gateway.createRequests).toBe(0);
      expect(gateway.wsConnections).toBe(0);
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
