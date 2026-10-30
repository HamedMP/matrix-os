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
    if (req.url === "/api/system/logs?service=gateway&lines=200") {
      res.end(JSON.stringify({ service: "gateway", lines: ["ready"], truncated: false }));
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
        ["instance", "logs", "--gateway", platformUrl, "--token", "cloud-token", "--json"],
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
        { v: 1, ok: true, data: { service: "gateway", lines: ["ready"], truncated: false } },
      ]);

      const restart = await runMatrixCli(["instance", "restart", "--platform", platformUrl, "--token", "cloud-token", "--json"]);
      expect(restart.status).toBe(1);
      expect(restart.stdout).toBe("");
      expect(JSON.parse(restart.stderr)).toMatchObject({ v: 1, error: { code: "instance_restart_unavailable" } });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it("calls gateway instance endpoints with bounded fetches", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/api/system/logs")) {
        return new Response(JSON.stringify({ service: "shell", lines: ["ready"], truncated: false }));
      }
      return new Response(JSON.stringify({ status: "ok", version: "v-test" }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const logs = captureLogs();

    await instanceCommand.subCommands!.info.run!({ args: { json: true } } as never);
    await instanceCommand.subCommands!.logs.run!({
      args: { json: true, service: "shell", lines: "50", since: "2h" },
    } as never);

    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.com/api/system/info", {
      headers: { Authorization: "Bearer cloud-token" },
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/system/logs?service=shell&lines=50&since=2h",
      { headers: { Authorization: "Bearer cloud-token" }, signal: expect.any(AbortSignal) },
    );
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { v: 1, ok: true, data: { status: "ok", version: "v-test" } },
      { v: 1, ok: true, data: { service: "shell", lines: ["ready"], truncated: false } },
    ]);
  });

  it("prints log lines as plain text without --json", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      service: "gateway", lines: ["first", "second"], truncated: false,
    }))));
    const logs = captureLogs();

    await instanceCommand.subCommands!.logs.run!({ args: {} } as never);

    expect(process.exitCode).toBeUndefined();
    expect(logs).toEqual(["first", "second"]);
  });

  it("says when there are no log entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      service: "gateway", lines: [], truncated: false,
    }))));
    const logs = captureLogs();

    await instanceCommand.subCommands!.logs.run!({ args: {} } as never);

    expect(logs).toEqual(["No log entries for gateway."]);
  });

  it("rejects invalid log arguments before making a request", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));

    for (const args of [{ service: "postgres" }, { lines: "5000" }, { lines: "ten" }, { since: "1 hour" }, { since: "30d" }]) {
      process.exitCode = undefined;
      await instanceCommand.subCommands!.logs.run!({ args: { json: true, ...args } } as never);
      expect(process.exitCode).toBe(1);
    }

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errors.map((line) => JSON.parse(line).error.code)).toEqual(Array(5).fill("invalid_arguments"));
  });

  it("explains that an older computer needs an update when the logs route is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));

    await instanceCommand.subCommands!.logs.run!({ args: { json: true } } as never);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(errors[0])).toEqual({
      v: 1,
      error: {
        code: "instance_logs_unsupported",
        message: "This Matrix computer does not support logs yet.",
        upstream: "gateway_system_logs_api",
        cause: "http",
        httpStatus: 404,
        retryable: false,
        nextStep: "Update your Matrix computer, then try again.",
      },
    });
  });

  it("emits sanitized JSON when the gateway logs request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("journal exploded", { status: 503 })));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));

    await instanceCommand.subCommands!.logs.run!({ args: { json: true } } as never);

    expect(JSON.parse(errors[0])).toEqual({
      v: 1,
      error: {
        code: "instance_request_failed",
        message: "Instance logs request failed.",
        upstream: "gateway_system_logs_api",
        cause: "http",
        httpStatus: 503,
        retryable: true,
      },
    });
    expect(errors[0]).not.toContain("journal exploded");
  });

  it("rejects malformed log responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ lines: [1, 2] }))));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));

    await instanceCommand.subCommands!.logs.run!({ args: { json: true } } as never);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(errors[0]).error).toMatchObject({ code: "instance_request_failed", cause: "invalid_response" });
  });

  it("fails restart fast without calling a nonexistent platform route", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));

    await instanceCommand.subCommands!.restart.run!({ args: { json: true } } as never);

    expect(process.exitCode).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(errors[0])).toEqual({
      v: 1,
      error: {
        code: "instance_restart_unavailable",
        message: "Instance restart is not available yet.",
        retryable: false,
        nextStep: "Run `matrix doctor` to check your Matrix computer.",
      },
    });
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
