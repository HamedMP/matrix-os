import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
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

async function createFakeAttachGateway() {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  const wss = new WebSocketServer({ server, path: "/ws/terminal/session" });
  let wsConnections = 0;
  wss.on("connection", (ws) => {
    wsConnections += 1;
    ws.send(JSON.stringify({ type: "attached" }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "exit", code: 0 }));
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
    get wsConnections() {
      return wsConnections;
    },
    async close() {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function createInputWebSocket(sentInputs: string[]) {
  return class InputWebSocket {
    constructor(_url: string, _options?: unknown) {}
    send(data: string) {
      const message = JSON.parse(data);
      if (message.type === "input") {
        sentInputs.push(message.data);
      }
    }
    close() {}
    on(event: "open" | "message", listener: (...args: unknown[]) => void) {
      if (event === "open") {
        queueMicrotask(() => listener());
      }
      if (event === "message") {
        queueMicrotask(() => listener(JSON.stringify({ type: "attached" })));
      }
      return this;
    }
    off() {
      return this;
    }
  };
}

function createPasteFetch(uploadPayload: Record<string, unknown>, sentInputs: string[]) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/api/files/blob")) {
      return new Response(JSON.stringify(uploadPayload));
    }
    if (href.includes("/api/terminal/sessions/main/input")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { data?: unknown };
      if (typeof body.data === "string") {
        sentInputs.push(body.data);
      }
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`unexpected fetch ${href}`);
  });
}

async function runMatrixCli(args: string[]) {
  const bin = join(process.cwd(), "packages/sync-client/bin/matrix.mjs");
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
        HOME: process.env.HOME ?? "",
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
      "paste-clipboard",
      "paste-file",
      "paste-screenshot",
      "rm",
      "tab",
    ]);
  });

  it("declares --no-rich-paste on shell attach and new --attach paths", () => {
    expect(shellCommand.subCommands!.attach.args).toHaveProperty("noRichPaste");
    expect(shellCommand.subCommands!.connect.args).toHaveProperty("noRichPaste");
    expect(shellCommand.subCommands!.new.args).toHaveProperty("noRichPaste");
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

    expect(logs).toEqual(["Usage: mos shell list|new|attach|paste-file|paste-clipboard|paste-screenshot|rm|tab|pane|layout"]);
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

    expect(logs).toEqual(["Usage: mos shell list|new|attach|paste-file|paste-clipboard|paste-screenshot|rm|tab|pane|layout"]);
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

    expect(logs).toEqual(["Usage: mos shell list|new|attach|paste-file|paste-clipboard|paste-screenshot|rm|tab|pane|layout"]);
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
          message: 'Not logged in for profile "local". Run `mos login` first.',
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
        message: 'Auth for profile "local" expired on 2026-05-29T23:24:06.000Z. Run `mos login --profile local` to refresh.',
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
        message: "Matrix CLI auth expired. Run `mos login` to refresh your session.",
      },
    });
  });

  it("emits one clean JSON error from the real CLI when auth is missing", () => {
    const bin = join(process.cwd(), "packages/sync-client/bin/matrix.mjs");

    const result = spawnSync(process.execPath, [bin, "shell", "ls", "--dev", "--json"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: process.env.HOME ?? "", NODE_NO_WARNINGS: "1" },
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      JSON.stringify({
        v: 1,
        error: {
          code: "not_authenticated",
          message: 'Not logged in for profile "local". Run `mos login` first.',
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

  it("caps paste-file terminal input to the shell input limit", async () => {
    const root = process.env.HOME ?? await tempHome();
    const localPath = join(root, "paste.txt");
    await writeFile(localPath, "paste me");
    const sentInputs: string[] = [];
    const longRemotePath = `data/terminal-paste/${"x".repeat(70_000)}.txt`;
    vi.stubGlobal("fetch", createPasteFetch({ path: longRemotePath, size: 8 }, sentInputs));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await shellCommand.subCommands!["paste-file"].run!({
      args: {
        session: "main",
        local: localPath,
        remote: longRemotePath,
        dev: true,
        token: "tok",
        force: true,
      },
    } as never);

    expect(process.exitCode).toBeUndefined();
    expect(sentInputs).toHaveLength(1);
    expect(sentInputs[0]!.length).toBeLessThanOrEqual(65_536);
    expect(sentInputs[0]!.startsWith("\x1b[200~")).toBe(true);
    expect(sentInputs[0]!.endsWith("\x1b[201~")).toBe(true);
  });

  it("pastes saved files as an agent-readable prompt by default", async () => {
    const root = process.env.HOME ?? await tempHome();
    const localPath = join(root, "screenshot.png");
    await writeFile(localPath, "fake image");
    const sentInputs: string[] = [];
    vi.stubGlobal("fetch", createPasteFetch({
      path: "data/terminal-paste/paste-1.png",
      size: 10,
    }, sentInputs));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await shellCommand.subCommands!["paste-file"].run!({
      args: {
        session: "main",
        local: localPath,
        dev: true,
        token: "tok",
      },
    } as never);

    expect(sentInputs).toEqual([
      "\x1b[200~Screenshot attached at /home/matrix/home/data/terminal-paste/paste-1.png (also ~/data/terminal-paste/paste-1.png). Please inspect it.\x1b[201~",
    ]);
  });

  it("supports path-only saved-file paste with enter submission", async () => {
    const root = process.env.HOME ?? await tempHome();
    const localPath = join(root, "notes.txt");
    await writeFile(localPath, "notes");
    const sentInputs: string[] = [];
    vi.stubGlobal("fetch", createPasteFetch({
      path: "data/terminal-paste/notes.txt",
      size: 5,
    }, sentInputs));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await shellCommand.subCommands!["paste-file"].run!({
      args: {
        session: "main",
        local: localPath,
        dev: true,
        token: "tok",
        format: "path",
        enter: true,
      },
    } as never);

    expect(sentInputs).toEqual(["\x1b[200~/home/matrix/home/data/terminal-paste/notes.txt\x1b[201~\r"]);
  });

  it("uploads clipboard images and pastes an agent prompt into the target shell", async () => {
    const sentInputs: string[] = [];
    vi.stubGlobal("fetch", createPasteFetch({
      path: "data/terminal-paste/clipboard.png",
      size: 12,
    }, sentInputs));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await shellCommand.subCommands!["paste-clipboard"].run!({
      args: {
        session: "main",
        dev: true,
        token: "tok",
        message: "Please compare this screenshot with the current UI.",
        readClipboardImage: async () => ({
          bytes: Buffer.from("fake clipboard png"),
          extension: "png",
          basename: "clipboard.png",
        }),
      },
    } as never);

    expect(sentInputs).toEqual([
      "\x1b[200~Please compare this screenshot with the current UI.\n\nScreenshot attached at /home/matrix/home/data/terminal-paste/clipboard.png (also ~/data/terminal-paste/clipboard.png). Please inspect it.\x1b[201~",
    ]);
  });

  it("captures screenshots and pastes an agent prompt into the target shell", async () => {
    const root = process.env.HOME ?? await tempHome();
    const screenshotPath = join(root, "captured.png");
    await writeFile(screenshotPath, "fake captured png");
    const sentInputs: string[] = [];
    vi.stubGlobal("fetch", createPasteFetch({
      path: "data/terminal-paste/captured.png",
      size: 17,
    }, sentInputs));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await shellCommand.subCommands!["paste-screenshot"].run!({
      args: {
        session: "main",
        dev: true,
        token: "tok",
        area: true,
        captureScreenshot: async () => ({ path: screenshotPath, cleanup: async () => {} }),
      },
    } as never);

    expect(sentInputs[0]).toContain("Screenshot attached at /home/matrix/home/data/terminal-paste/captured.png");
  });

  it.each(["connect", "attach"])("keeps stdout JSON-only for shell %s --json", async (verb) => {
    const gateway = await createFakeAttachGateway();
    try {
      const result = await runMatrixCli([
        "shell",
        verb,
        "main",
        "--gateway",
        gateway.gatewayUrl,
        "--token",
        "tok",
        "--json",
      ]);

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).not.toContain("\u001b[");
      expect(JSON.parse(result.stdout)).toEqual({
        v: 1,
        ok: true,
        data: { detached: false },
      });
      expect(result.stderr).toContain("\u001b[?1000l");
      expect(gateway.wsConnections).toBe(1);
    } finally {
      await gateway.close();
    }
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
        if (event === "open") {
          queueMicrotask(() => listener());
        }
        if (event === "message") {
          queueMicrotask(() => listener(JSON.stringify({ type: "attached" })));
          queueMicrotask(() => listener(JSON.stringify({ type: "exit", code: 0 })));
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
      "Shell attach ended. Reattach: mos shell attach main",
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
          queueMicrotask(() => listener(JSON.stringify({ type: "attached" })));
          queueMicrotask(() => listener(JSON.stringify({ type: "output", data: "REMOTE_BYTES" })));
          queueMicrotask(() => listener(JSON.stringify({ type: "exit", code: 0 })));
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
      { v: 1, ok: true, data: { created: { name: "main", created: true }, detached: false } },
    ]);
    expect(stdoutWrites.join("")).not.toContain("REMOTE_BYTES");
    expect(stderrWrites.join("")).toContain("REMOTE_BYTES");
  });

  it("honors connect --json without writing terminal bytes to stdout", async () => {
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
          queueMicrotask(() => listener(JSON.stringify({ type: "attached" })));
          queueMicrotask(() => listener(JSON.stringify({ type: "output", data: "CONNECT_BYTES" })));
          queueMicrotask(() => listener(JSON.stringify({ type: "exit", code: 0 })));
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

    await shellCommand.subCommands!.connect.run!({
      args: { name: "main", dev: true, token: "tok", json: true, WebSocketImpl: OutputWebSocket },
    } as never);

    expect(OutputWebSocket.instances).toBe(1);
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { v: 1, ok: true, data: { detached: false } },
    ]);
    expect(stdoutWrites.join("")).not.toContain("CONNECT_BYTES");
    expect(stderrWrites.join("")).toContain("CONNECT_BYTES");
  });

  it("honors connect -c --json by creating and attaching", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (/\/api\/(?:terminal\/)?sessions$/.test(url) && init?.method === "POST") {
        return new Response(JSON.stringify({ name: "main", created: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    class CreateThenOutputWebSocket {
      static instances = 0;
      private readonly instance: number;
      constructor(_url: string, _options?: unknown) {
        CreateThenOutputWebSocket.instances += 1;
        this.instance = CreateThenOutputWebSocket.instances;
      }
      send() {}
      close() {}
      on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void) {
        if (event === "open") {
          queueMicrotask(() => listener());
        }
        if (event === "message" && this.instance === 1) {
          queueMicrotask(() => listener(JSON.stringify({ type: "error", code: "session_not_found" })));
        }
        if (event === "message" && this.instance === 2) {
          queueMicrotask(() => listener(JSON.stringify({ type: "attached" })));
          queueMicrotask(() => listener(JSON.stringify({ type: "output", data: "CREATED_CONNECT_BYTES" })));
          queueMicrotask(() => listener(JSON.stringify({ type: "exit", code: 0 })));
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

    await shellCommand.subCommands!.connect.run!({
      args: { name: "main", create: true, dev: true, token: "tok", json: true, WebSocketImpl: CreateThenOutputWebSocket },
    } as never);

    expect(CreateThenOutputWebSocket.instances).toBe(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/terminal\/sessions$/),
      expect.objectContaining({ method: "POST" }),
    );
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { v: 1, ok: true, data: { created: { name: "main", created: true }, detached: false } },
    ]);
    expect(stdoutWrites.join("")).not.toContain("CREATED_CONNECT_BYTES");
    expect(stderrWrites.join("")).toContain("CREATED_CONNECT_BYTES");
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
        if (event === "message" && this.instance === 2) {
          queueMicrotask(() => listener(JSON.stringify({ type: "attached" })));
          queueMicrotask(() => listener(JSON.stringify({ type: "exit", code: 0 })));
        }
        if (event === "open") {
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
    expect(logs).toContain("Shell attach ended. Reattach: mos shell attach 1");
  });
});
