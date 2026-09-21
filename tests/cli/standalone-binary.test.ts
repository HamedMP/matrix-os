import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

async function waitForLog(
  logPath: string,
  expected: string,
  child: ChildProcess,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const log = await readFile(logPath, "utf8");
      if (log.includes(expected)) return log;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Standalone daemon exited before logging ${JSON.stringify(expected)}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for standalone daemon log: ${expected}`);
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  child.kill("SIGTERM");
  const forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000);
  forceStop.unref();
  await closed;
  clearTimeout(forceStop);
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function expectHappyPathDaemonStartsOnce(options: {
  command: string;
  args: string[];
  cwd: string;
  tempPrefix: string;
  expectSpawnedPid: boolean;
}): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), options.tempPrefix));
  const homeDir = join(tempRoot, "home");
  const configDir = join(homeDir, ".matrixos");
  const syncPath = join(homeDir, "sync");
  const logPath = join(configDir, "logs", "sync.log");
  let server: Server | undefined;
  let daemon: ChildProcess | undefined;

  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(syncPath, { recursive: true });
    server = createServer((request, response) => {
      if (request.url !== "/api/sync/manifest") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        manifestVersion: 1,
        manifest: { version: 2, files: {} },
      }));
    });
    await new Promise<void>((resolveListen, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test gateway did not bind TCP");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;

    await writeFile(join(configDir, "config.json"), JSON.stringify({
      gatewayUrl,
      syncPath,
      gatewayFolder: "",
      peerId: "daemon-happy-path",
      pauseSync: true,
      syncDaemonRuntime: "standalone",
    }));
    await writeFile(join(configDir, "auth.json"), JSON.stringify({
      accessToken: "isolated-test-token",
      expiresAt: Date.now() + 60_000,
      userId: "daemon-test-user",
      handle: "daemon-test-user",
    }));

    const { MATRIX_CLI_STANDALONE: _buildOnlyMarker, ...runtimeEnv } = process.env;
    daemon = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...runtimeEnv, HOME: homeDir },
      stdio: "ignore",
    });

    await waitForLog(logPath, "Daemon started", daemon);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const startupLog = await readFile(logPath, "utf8");
    expect(daemon.exitCode, startupLog).toBeNull();
    expect(startupLog.match(/Daemon started/g)).toHaveLength(1);
    expect(startupLog).not.toContain("Could not acquire daemon pid file");
    const daemonPid = await readFile(join(configDir, "daemon.pid"), "utf8");
    expect(daemonPid).toMatch(/^\d+$/);
    if (options.expectSpawnedPid) expect(daemonPid).toBe(String(daemon.pid));
  } finally {
    await stopProcess(daemon);
    await closeServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

describe("standalone CLI binary", () => {
  let buildRoot: string;
  let binaryPath: string;

  beforeAll(async () => {
    buildRoot = await mkdtemp(join(tmpdir(), "matrix-standalone-build-"));
    binaryPath = join(buildRoot, process.platform === "win32" ? "matrix.exe" : "matrix");
    const build = spawnSync(
      "bun",
      [
        "build",
        resolve(repoRoot, "packages/sync-client/src/cli/index.ts"),
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--outfile",
        binaryPath,
        "--define",
        'process.env.MATRIX_CLI_STANDALONE="1"',
        "--define",
        'process.env.MATRIX_CLI_VERSION="compiled-smoke"',
      ],
      { cwd: repoRoot, encoding: "utf8", env: process.env },
    );
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
  }, 30_000);

  afterAll(async () => {
    await rm(buildRoot, { recursive: true, force: true });
  });

  it("dispatches the hidden sync daemon without the build-only runtime variable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "matrix-standalone-daemon-"));
    const homeDir = join(tempRoot, "home");
    try {
      await mkdir(homeDir, { recursive: true });
      const { MATRIX_CLI_STANDALONE: _buildOnlyMarker, ...runtimeEnv } = process.env;
      const daemon = spawnSync(binaryPath, ["__daemon"], {
        cwd: tempRoot,
        encoding: "utf8",
        env: { ...runtimeEnv, HOME: homeDir },
        timeout: 20_000,
      });
      const output = `${daemon.stdout}\n${daemon.stderr}`;
      expect(daemon.status, output).toBe(1);
      expect(output).not.toContain("Unknown command");
      expect(output).not.toContain("_flushSync took too long");
      expect(await readFile(join(homeDir, ".matrixos/logs/sync.log"), "utf8"))
        .toContain("No config found. Run 'matrixos sync <path>' first.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it("starts the compiled daemon exactly once on a valid happy path", async () => {
    await expectHappyPathDaemonStartsOnce({
      command: binaryPath,
      args: ["__daemon"],
      cwd: buildRoot,
      tempPrefix: "matrix-standalone-happy-",
      expectSpawnedPid: true,
    });
  }, 30_000);

  it("starts the source daemon entrypoint exactly once on a valid happy path", async () => {
    await expectHappyPathDaemonStartsOnce({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        resolve(repoRoot, "packages/sync-client/src/daemon/main.ts"),
      ],
      cwd: repoRoot,
      tempPrefix: "matrix-source-daemon-happy-",
      expectSpawnedPid: true,
    });
  }, 30_000);
});
