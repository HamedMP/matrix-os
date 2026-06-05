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

  it("registers list/ls, new, connect/attach, and rm session subcommands", () => {
    expect(Object.keys(shellCommand.subCommands ?? {}).sort()).toEqual([
      "attach",
      "connect",
      "layout",
      "list",
      "ls",
      "new",
      "pane",
      "rm",
      "tab",
    ]);
  });

  it("keeps aliases as distinct command objects with canonical names", () => {
    expect(shellCommand.subCommands!.connect).not.toBe(shellCommand.subCommands!.attach);
    expect(shellCommand.subCommands!.connect.meta?.name).toBe("connect");
    expect(shellCommand.subCommands!.list).not.toBe(shellCommand.subCommands!.ls);
    expect(shellCommand.subCommands!.list.meta?.name).toBe("list");
  });

  it("prints complete usage for the bare shell command", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.run?.({ args: {} } as never);

    expect(logs).toEqual(["Usage: matrix shell list|new|connect|rm|tab|pane|layout"]);
  });

  it("prints usage for the bare shell command with valued root flags", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.run?.({
      rawArgs: ["--profile", "local", "--gateway", "https://gateway.example", "--json"],
      args: {},
    } as never);

    expect(logs).toEqual(["Usage: matrix shell list|new|connect|rm|tab|pane|layout"]);
  });

  it("prints usage when a root flag value matches a shell subcommand", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.run?.({
      rawArgs: ["--profile", "ls", "--gateway=tab", "--json"],
      args: {},
    } as never);

    expect(logs).toEqual(["Usage: matrix shell list|new|connect|rm|tab|pane|layout"]);
  });

  it("does not print usage after subcommands run", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.run?.({ rawArgs: ["ls", "--dev", "--json"], args: {} } as never);

    expect(logs).toEqual([]);
  });

  it("does not print usage when root flags precede a subcommand", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.run?.({
      rawArgs: ["--profile", "local", "--json", "ls"],
      args: {},
    } as never);

    expect(logs).toEqual([]);
  });

  it("does not print usage for the friendlier list and connect verbs", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.run?.({ rawArgs: ["list", "--dev", "--json"], args: {} } as never);
    await shellCommand.run?.({ rawArgs: ["connect", "main"], args: {} } as never);

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

  it("prompts for login when profile auth is expired", async () => {
    await saveProfileAuth("local", {
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      expiresAt: Date.parse("2026-05-29T23:24:06.000Z"),
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
        code: "auth_expired",
        message: 'Auth for profile "local" expired on 2026-05-29T23:24:06.000Z. Run `matrix login --profile local` to refresh.',
      },
    });
  });

  it("prompts for login when the gateway rejects profile auth", async () => {
    await saveProfileAuth("local", {
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      userId: "user-1",
      handle: "local",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401 },
    )));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });

    await shellCommand.subCommands!.ls.run!({
      args: { dev: true, json: true },
    } as never);

    expect(JSON.parse(errors[0]!)).toEqual({
      v: 1,
      error: {
        code: "auth_expired",
        message: "Matrix CLI auth expired. Run `matrix login` to refresh your session.",
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
      if (url.endsWith("/api/terminal/sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ name: "main", created: true }), { status: 201 });
      }
      if (url.endsWith("/api/terminal/sessions/main")) {
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

  it("creates shell sessions without attaching by default", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (/\/api\/(?:terminal\/)?sessions$/.test(url) && init?.method === "POST") {
        return new Response(JSON.stringify({ name: "main", created: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    class UnexpectedWebSocket {
      constructor() {
        throw new Error("new should not attach by default");
      }
    }
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.subCommands!.new.run!({
      args: { name: "main", dev: true, token: "tok", WebSocketImpl: UnexpectedWebSocket },
    } as never);

    expect(logs).toEqual(["Created shell session main"]);
  });

  it("attaches new shell sessions when requested", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (/\/api\/(?:terminal\/)?sessions$/.test(url) && init?.method === "POST") {
        return new Response(JSON.stringify({ name: "main", created: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    class ClosingWebSocket {
      static instances = 0;
      constructor(_url: string, _options?: unknown) {
        ClosingWebSocket.instances += 1;
      }
      send() {}
      close() {}
      on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void) {
        if (event === "open" || event === "close") {
          queueMicrotask(() => listener());
        }
        return this;
      }
      off() {
        return this;
      }
    }
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.subCommands!.new.run!({
      args: { name: "main", attach: true, dev: true, token: "tok", WebSocketImpl: ClosingWebSocket },
    } as never);

    expect(ClosingWebSocket.instances).toBe(1);
    expect(logs).toEqual([
      "Created shell session main. Attaching...",
      "Detached. Reattach: matrix shell connect main",
    ]);
  });

  it("honors new --attach --json without writing terminal bytes to stdout", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (/\/api\/(?:terminal\/)?sessions$/.test(url) && init?.method === "POST") {
        return new Response(JSON.stringify({ name: "main", created: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    class OutputWebSocket {
      static instances = 0;
      constructor(_url: string, _options?: unknown) {
        OutputWebSocket.instances += 1;
      }
      send() {}
      close() {}
      on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void) {
        if (event === "open") {
          queueMicrotask(() => listener());
        }
        if (event === "message") {
          queueMicrotask(() => listener(JSON.stringify({ type: "output", data: "REMOTE_BYTES" })));
        }
        if (event === "close") {
          queueMicrotask(() => listener());
        }
        return this;
      }
      off() {
        return this;
      }
    }
    const logs: string[] = [];
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await shellCommand.subCommands!.new.run!({
      args: { name: "main", attach: true, dev: true, token: "tok", json: true, WebSocketImpl: OutputWebSocket },
    } as never);

    expect(OutputWebSocket.instances).toBe(1);
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { v: 1, ok: true, data: { created: { name: "main", created: true }, detached: true } },
    ]);
    expect(stdoutWrites.join("")).not.toContain("REMOTE_BYTES");
    expect(stderrWrites.join("")).toContain("REMOTE_BYTES");
  });

  it("creates missing sessions with connect -c", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ name: "1", created: true }), { status: 201 });
      }
      return new Response(JSON.stringify({ sessions: [] }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    class ClosingWebSocket {
      static instances = 0;
      private readonly instance: number;
      constructor(_url: string, _options?: unknown) {
        ClosingWebSocket.instances += 1;
        this.instance = ClosingWebSocket.instances;
      }
      send() {}
      close() {}
      on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void) {
        if (event === "message" && this.instance === 1) {
          queueMicrotask(() => listener(JSON.stringify({ type: "error", code: "session_not_found" })));
        }
        if (event === "open" || (event === "close" && this.instance === 2)) {
          queueMicrotask(() => listener());
        }
        return this;
      }
      off() {
        return this;
      }
    }
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.subCommands!.connect.run!({
      args: { name: "1", create: true, dev: true, token: "tok", WebSocketImpl: ClosingWebSocket },
    } as never);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/terminal\/sessions$/),
      expect.objectContaining({ method: "POST" }),
    );
    expect(logs).toContain("Created shell session 1. Connecting...");
    expect(logs).toContain("Detached. Reattach: matrix shell connect 1");
  });
});
