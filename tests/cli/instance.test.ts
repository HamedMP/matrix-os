import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfileAuth } from "../../packages/sync-client/src/auth/token-store.js";
import { instanceCommand } from "../../packages/sync-client/src/cli/commands/instance.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), "matrix-instance-cli-"));
  roots.push(root);
  process.env.HOME = root;
}

function captureLogs() {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    logs.push(String(line));
  });
  return logs;
}

async function runMatrixCli(args: string[]): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const bin = join(process.cwd(), "packages/sync-client/bin/matrix.mjs");
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: process.env.HOME ?? "",
      MATRIX_HOME: join(process.env.HOME ?? "", "matrix-home"),
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const status = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("matrix_cli_timeout"));
    }, 10_000);
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  return { status, stdout, stderr };
}

function expectJsonStdout(stdout: string): unknown {
  expect(stdout).not.toContain("Usage: matrix instance info|restart|logs");
  return JSON.parse(stdout);
}

async function startInstanceServer(): Promise<{ server: Server; platformUrl: string }> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/instance/restart") {
      res.end(JSON.stringify({ restarted: true }));
      return;
    }
    if (req.url === "/api/instance/logs") {
      res.end(JSON.stringify({ lines: ["ready"] }));
      return;
    }
    if (req.url === "/api/system/info") {
      res.end(JSON.stringify({ status: "ok", version: "v-test" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, platformUrl: `http://127.0.0.1:${address.port}` };
}

beforeEach(async () => {
  process.exitCode = undefined;
  await tempHome();
  await saveProfileAuth("cloud", {
    accessToken: "cloud-token",
    expiresAt: Date.now() + 60_000,
    userId: "user_cloud",
    handle: "cloud",
  });
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("instance CLI command", () => {
  it("registers info, restart, and logs subcommands", () => {
    expect(Object.keys(instanceCommand.subCommands ?? {}).sort()).toEqual([
      "info",
      "logs",
      "restart",
    ]);
  });

  it("emits clean process-level JSON for instance subcommands", async () => {
    const { server, platformUrl } = await startInstanceServer();
    try {
      const commands = [
        ["instance", "info", "--gateway", platformUrl, "--token", "cloud-token", "--json"],
        ["instance", "restart", "--platform", platformUrl, "--token", "cloud-token", "--json"],
        ["instance", "logs", "--platform", platformUrl, "--token", "cloud-token", "--json"],
      ];

      const outputs = [];
      for (const args of commands) {
        const result = await runMatrixCli(args);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        outputs.push(expectJsonStdout(result.stdout));
      }

      expect(outputs).toEqual([
        { v: 1, ok: true, data: { status: "ok", version: "v-test" } },
        { v: 1, ok: true, data: { restarted: true } },
        { v: 1, ok: true, data: { lines: ["ready"] } },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it("calls profile-scoped instance endpoints with bounded fetches", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/instance/restart")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ restarted: true }));
      }
      if (url.endsWith("/api/instance/logs")) {
        return new Response(JSON.stringify({ lines: ["ready"] }));
      }
      return new Response(JSON.stringify({ status: "ok", version: "v-test" }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const logs = captureLogs();

    await instanceCommand.subCommands!.info.run!({ args: { json: true } } as never);
    await instanceCommand.subCommands!.restart.run!({ args: { json: true } } as never);
    await instanceCommand.subCommands!.logs.run!({ args: { json: true } } as never);

    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.com/api/system/info", {
      headers: { Authorization: "Bearer cloud-token" },
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.com/api/instance/restart", {
      method: "POST",
      headers: { Authorization: "Bearer cloud-token" },
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.com/api/instance/logs", {
      headers: { Authorization: "Bearer cloud-token" },
      signal: expect.any(AbortSignal),
    });
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { v: 1, ok: true, data: { status: "ok", version: "v-test" } },
      { v: 1, ok: true, data: { restarted: true } },
      { v: 1, ok: true, data: { lines: ["ready"] } },
    ]);
  });

  it("reads instance info directly from the real gateway system-info endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://gateway.example/api/system/info") {
        return new Response(JSON.stringify({ status: "ok", version: "v2026.09.25" }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    const logs = captureLogs();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));

    await instanceCommand.subCommands!.info.run!({
      args: {
        json: true,
        platform: "https://platform.example",
        gateway: "https://gateway.example",
      },
    } as never);

    expect(process.exitCode).toBeUndefined();
    expect(errors).toEqual([]);
    expect(JSON.parse(logs[0])).toEqual({
      v: 1,
      ok: true,
      data: {
        status: "ok",
        version: "v2026.09.25",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("identifies a gateway system-info timeout without probing a bogus platform route", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://gateway.example/api/system/info") {
        throw new DOMException("timed out", "TimeoutError");
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));

    await instanceCommand.subCommands!.info.run!({
      args: {
        json: true,
        platform: "https://platform.example",
        gateway: "https://gateway.example",
      },
    } as never);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(errors[0])).toEqual({
      v: 1,
      error: {
        code: "instance_request_failed",
        message: "Instance information request failed.",
        upstream: "gateway_system_info_api",
        cause: "timeout",
        retryable: true,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("emits sanitized JSON when gateway system info fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider exploded", { status: 502 })));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });

    await instanceCommand.subCommands!.info.run!({ args: { json: true } } as never);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(errors[0])).toEqual({
      v: 1,
      error: {
        code: "instance_request_failed",
        message: "Instance information request failed.",
        upstream: "gateway_system_info_api",
        cause: "http",
        httpStatus: 502,
        retryable: true,
      },
    });
    expect(errors[0]).not.toContain("provider exploded");
  });
});
