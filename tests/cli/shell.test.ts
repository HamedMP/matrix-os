import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfileAuth } from "../../packages/sync-client/src/auth/token-store.js";
import { shellCommand } from "../../packages/sync-client/src/cli/commands/shell.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-cli-"));
  roots.push(root);
  process.env.HOME = root;
  return root;
}

beforeEach(async () => {
  process.exitCode = undefined;
  await tempHome();
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shell CLI command", () => {
  it("exports the shell command namespace", () => {
    expect(shellCommand.meta?.name).toBe("shell");
  });

  it("registers ls, new, attach, and rm session subcommands", () => {
    expect(Object.keys(shellCommand.subCommands ?? {}).sort()).toEqual([
      "attach",
      "layout",
      "ls",
      "new",
      "pane",
      "rm",
      "tab",
    ]);
  });

  it("prints complete usage for the bare shell command", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.run?.({ args: {} } as never);

    expect(logs).toEqual(["Usage: matrix shell ls|new|attach|rm|tab|pane|layout"]);
  });

  it("does not print usage after subcommands run", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.run?.({ rawArgs: ["ls", "--dev", "--json"], args: {} } as never);

    expect(logs).toEqual([]);
  });

  it("fails before fetch when profile auth is missing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sessions: [] })));
    vi.stubGlobal("fetch", fetchImpl);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });

    await shellCommand.subCommands!.ls.run!({
      args: { dev: true, json: true },
    } as never);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errors.map((line) => JSON.parse(line))).toEqual([
      {
        v: 1,
        error: {
          code: "not_authenticated",
          message: 'Not logged in for profile "local". Run `matrix login` first.',
        },
      },
    ]);
  });

  it("treats expired profile auth as not authenticated", async () => {
    await saveProfileAuth("local", {
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1,
      userId: "user-1",
      handle: "local",
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sessions: [] })));
    vi.stubGlobal("fetch", fetchImpl);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });

    await shellCommand.subCommands!.ls.run!({
      args: { dev: true, json: true },
    } as never);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(errors[0]!)).toEqual({
      v: 1,
      error: {
        code: "not_authenticated",
        message: 'Not logged in for profile "local". Run `matrix login` first.',
      },
    });
  });

  it("emits one clean JSON error from the real CLI when auth is missing", () => {
    const bin = join(process.cwd(), "packages/sync-client/bin/matrix.mjs");

    const result = spawnSync(process.execPath, [bin, "shell", "ls", "--dev", "--json"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: process.env.HOME ?? "" },
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      JSON.stringify({
        v: 1,
        error: {
          code: "not_authenticated",
          message: 'Not logged in for profile "local". Run `matrix login` first.',
        },
      }),
    );
  });

  it("emits versioned JSON for ls, new, and rm", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ name: "main", created: true }), { status: 201 });
      }
      if (url.endsWith("/api/sessions/main")) {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response(JSON.stringify({ sessions: [{ name: "main" }] }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.subCommands!.ls.run!({
      args: { dev: true, token: "tok", json: true },
    } as never);
    await shellCommand.subCommands!.new.run!({
      args: { name: "main", dev: true, token: "tok", json: true },
    } as never);
    await shellCommand.subCommands!.rm.run!({
      args: { name: "main", dev: true, token: "tok", json: true },
    } as never);

    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { v: 1, ok: true, data: { sessions: [{ name: "main" }] } },
      { v: 1, ok: true, data: { name: "main", created: true } },
      { v: 1, ok: true, data: { ok: true } },
    ]);
  });
});
