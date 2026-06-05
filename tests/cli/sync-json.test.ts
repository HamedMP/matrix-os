import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const bin = join(process.cwd(), "packages/sync-client/bin/matrix.mjs");
const rootBin = join(process.cwd(), "bin/matrixos.mjs");

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "matrix-sync-json-cli-"));
  roots.push(root);
  return root;
}

async function runCli(
  home: string,
  args: string[],
  commandBin = bin,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [commandBin, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("exit", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startDaemon(home: string): Promise<Server> {
  const configDir = join(home, ".matrixos");
  await mkdir(configDir, { recursive: true });
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const msg = JSON.parse(buffer.slice(0, idx)) as { command?: string };
      const result = msg.command === "status"
        ? { syncing: true, manifestVersion: 7, fileCount: 3, lastSyncAt: 1_710_000_000_000 }
        : {};
      socket.write(`${JSON.stringify({ v: 1, result })}\n`);
    });
  });
  await listen(server, join(configDir, "daemon.sock"));
  return server;
}

function expectSafeNoDaemonStderr(stderr: string, home: string): void {
  expect(stderr).not.toContain(home);
  expect(stderr).not.toContain(".matrixos");
  expect(stderr).not.toContain("daemon.sock");
  expect(stderr).not.toContain(" at ");
  expect(stderr).not.toContain("Socket.");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sync CLI JSON output", () => {
  it("emits a versioned status envelope when the daemon is not running", async () => {
    const home = await tempHome();

    const result = await runCli(home, ["sync", "status", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      v: 1,
      ok: true,
      data: { running: false },
    });
  });

  it("emits versioned success envelopes for daemon-backed sync commands", async () => {
    const home = await tempHome();
    const server = await startDaemon(home);

    try {
      const status = await runCli(home, ["sync", "status", "--json"]);
      const pause = await runCli(home, ["sync", "pause", "--json"]);
      const resume = await runCli(home, ["sync", "resume", "--json"]);

      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toEqual({
        v: 1,
        ok: true,
        data: {
          running: true,
          syncing: true,
          manifestVersion: 7,
          fileCount: 3,
          lastSyncAt: 1_710_000_000_000,
        },
      });
      expect(status.stderr).toBe("");

      expect(pause.status).toBe(0);
      expect(JSON.parse(pause.stdout)).toEqual({
        v: 1,
        ok: true,
        data: { paused: true },
      });
      expect(pause.stderr).toBe("");

      expect(resume.status).toBe(0);
      expect(JSON.parse(resume.stdout)).toEqual({
        v: 1,
        ok: true,
        data: { resumed: true },
      });
      expect(resume.stderr).toBe("");
    } finally {
      await closeServer(server);
    }
  });

  it("emits safe JSON errors for no-daemon pause and resume", async () => {
    const home = await tempHome();

    for (const command of ["pause", "resume"]) {
      const result = await runCli(home, ["sync", command, "--json"]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expectSafeNoDaemonStderr(result.stderr, home);
      expect(JSON.parse(result.stderr)).toEqual({
        v: 1,
        error: {
          code: "daemon_unavailable",
          message: "Sync daemon is not running.",
        },
      });
    }
  });

  it("emits safe human errors for no-daemon pause and resume", async () => {
    const home = await tempHome();

    for (const command of ["pause", "resume"]) {
      const result = await runCli(home, ["sync", command]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expectSafeNoDaemonStderr(result.stderr, home);
      expect(result.stderr.trim()).toBe("Error: Sync daemon is not running.");
    }
  });

  it("does not append wrapper errors after forwarded JSON sync failures", async () => {
    const home = await tempHome();

    const result = await runCli(home, ["sync", "pause", "--json"], rootBin);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expectSafeNoDaemonStderr(result.stderr, home);
    expect(JSON.parse(result.stderr)).toEqual({
      v: 1,
      error: {
        code: "daemon_unavailable",
        message: "Sync daemon is not running.",
      },
    });
  });
});
