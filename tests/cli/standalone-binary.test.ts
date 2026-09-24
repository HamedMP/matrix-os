import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function buildStandaloneBinary(tempRoot: string): string {
  const binaryPath = join(tempRoot, process.platform === "win32" ? "matrix.exe" : "matrix");
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
  return binaryPath;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((err) => err ? reject(err) : resolveClose());
  });
}

async function waitForLog(
  logPath: string,
  expected: string,
  child: ChildProcessWithoutNullStreams,
  output: () => string,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const log = await readFile(logPath, "utf8");
      if (log.includes(expected)) return log;
    } catch (err: unknown) {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Daemon exited before startup (${child.exitCode ?? child.signalCode})\n${output()}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for daemon startup\n${output()}`);
}

describe("standalone CLI binary", () => {
  it("dispatches the hidden sync daemon without the build-only runtime variable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "matrix-standalone-daemon-"));
    const homeDir = join(tempRoot, "home");
    try {
      await mkdir(homeDir, { recursive: true });
      const binaryPath = buildStandaloneBinary(tempRoot);

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

  it("starts the compiled standalone sync daemon exactly once", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "matrix-standalone-daemon-happy-"));
    const homeDir = join(tempRoot, "home");
    const configDir = join(homeDir, ".matrixos");
    const profileDir = join(configDir, "profiles", "local");
    const syncPath = join(homeDir, "sync");
    const gateway = createServer((req, res) => {
      if (req.url === "/api/sync/manifest") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          manifestVersion: 1,
          manifest: { version: 2, files: {} },
        }));
        return;
      }
      res.writeHead(404).end();
    });
    let daemon: ChildProcessWithoutNullStreams | undefined;

    try {
      const gatewayUrl = await listen(gateway);
      await mkdir(profileDir, { recursive: true });
      await mkdir(syncPath, { recursive: true });
      await writeFile(join(configDir, "profiles.json"), JSON.stringify({
        active: "local",
        profiles: { local: { platformUrl: gatewayUrl, gatewayUrl } },
      }));
      await writeFile(join(configDir, "sync-profile.json"), JSON.stringify({
        version: 1,
        profile: "local",
      }));
      await writeFile(join(profileDir, "config.json"), JSON.stringify({
        profile: "local",
        platformUrl: gatewayUrl,
        gatewayUrl,
        syncPath,
        gatewayFolder: "",
        peerId: "compiled-smoke",
        pauseSync: false,
        syncDaemonRuntime: "standalone",
      }));
      await writeFile(join(profileDir, "auth.json"), JSON.stringify({
        accessToken: "compiled-smoke-token",
        expiresAt: Date.now() + 60_000,
        userId: "compiled-smoke-user",
        handle: "compiled-smoke",
      }));

      const binaryPath = buildStandaloneBinary(tempRoot);
      const { MATRIX_CLI_STANDALONE: _buildOnlyMarker, ...runtimeEnv } = process.env;
      daemon = spawn(binaryPath, ["__daemon"], {
        cwd: tempRoot,
        env: { ...runtimeEnv, HOME: homeDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      daemon.stdout.on("data", (data) => { stdout += data.toString(); });
      daemon.stderr.on("data", (data) => { stderr += data.toString(); });

      const log = await waitForLog(
        join(configDir, "logs", "sync.log"),
        "Daemon started",
        daemon,
        () => `${stdout}\n${stderr}`,
      );

      expect(daemon.exitCode, `${stdout}\n${stderr}`).toBeNull();
      expect(log).not.toContain("Could not acquire daemon pid file");
    } finally {
      if (daemon?.exitCode === null && daemon.signalCode === null) {
        const exited = new Promise<void>((resolveExit) => daemon!.once("exit", () => resolveExit()));
        daemon.kill("SIGTERM");
        await exited;
      }
      await closeServer(gateway);
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 45_000);
});
