import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, HC_FRAME } from "@desktop/main/local-terminals/hc-protocol";
import { fakeCore } from "./fixtures/fake-herdr-core";
import { createLocalTerminalHost, localShellEnv, type LocalTerminalHostOptions } from "@desktop/main/local-terminals/host";
import { localLoginShell, resolveLocalTerminalRuntime, startLocalTerminalCore } from "@desktop/main/local-terminals/runtime";
import { LOCAL_TERMINAL_VERSION } from "@desktop/shared/local-terminals";

describe("local shell environment", () => {
  it("passes only the allowlist to the core and its shells", () => {
    expect(localShellEnv({
      HOME: "/Users/neo", USER: "neo", SHELL: "/bin/zsh", PATH: "/usr/bin", LANG: "en_US.UTF-8", LC_ALL: "C", TMPDIR: "/tmp/x",
      SSH_AUTH_SOCK: "/tmp/agent", MATRIX_API_ORIGIN: "x", OPERATOR_GATEWAY_URL: "x", ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--inspect", VITE_KEY: "x", POSTHOG_KEY: "x", CLERK_SECRET_KEY: "x", GITHUB_TOKEN: "x", ANTHROPIC_API_KEY: "x",
      XDG_CONFIG_HOME: "/elsewhere", undefinedValue: undefined,
    })).toEqual({ HOME: "/Users/neo", USER: "neo", SHELL: "/bin/zsh", PATH: "/usr/bin", LANG: "en_US.UTF-8", LC_ALL: "C",
      TMPDIR: "/tmp/x", SSH_AUTH_SOCK: "/tmp/agent" });
  });
});

describe("local status reporter", () => {
  it("installs a private executable reporter and emits herdr's actual OSC format", async () => {
    const { installLocalStatusReporter } = await import("@desktop/main/local-terminals/status-reporter");
    const root = scratchDir("mx-status-");
    const bin = await installLocalStatusReporter(root);
    const executable = join(bin, "matrix-status");
    expect(statSync(executable).mode & 0o777).toBe(0o700);
    expect(execFileSync(executable, ["blocked", "approve v2?"], { encoding: "utf8" }))
      .toBe("\x1b]7501;state=blocked:msg=YXBwcm92ZSB2Mj8=\x1b\\");
    expect(() => execFileSync(executable, ["bogus"], { stdio: "ignore" })).toThrow();
    expect(() => execFileSync(executable, ["blocked", "x".repeat(201)], { stdio: "ignore" })).toThrow();
  });
});

describe("local terminal shell", () => {
  it("uses SHELL, then the account's login shell, and /bin/sh only as a last resort", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(localLoginShell({ SHELL: "/bin/zsh" }, () => "/bin/bash")).toBe("/bin/zsh");
    // Opened from the Dock: no SHELL in the environment.
    expect(localLoginShell({}, () => "/opt/homebrew/bin/fish")).toBe("/opt/homebrew/bin/fish");
    expect(localLoginShell({ SHELL: "" }, () => "/bin/zsh")).toBe("/bin/zsh");
    expect(localLoginShell({ SHELL: "zsh" }, () => null)).toBe("/bin/sh");
    expect(localLoginShell({}, () => "relative/shell")).toBe("/bin/sh");
    expect(localLoginShell({}, () => { throw new Error("no passwd entry"); })).toBe("/bin/sh");
  });
});

describe("local terminal runtime location", () => {
  const base = { resourcesPath: "/app/resources", userData: "/Users/neo/Library/Application Support/Matrix OS", home: "/Users/neo" };
  it("uses only the bundled binary in a packaged app, ignoring any override", () => {
    const runtime = resolveLocalTerminalRuntime({ ...base, isPackaged: true, env: { MATRIX_DESKTOP_HC_PATH: "/usr/local/bin/hc" }, exists: () => true });
    expect(runtime.binaryPath).toBe("/app/resources/herdr/hc");
    expect(resolveLocalTerminalRuntime({ ...base, isPackaged: true, env: { MATRIX_DESKTOP_HC_PATH: "/usr/local/bin/hc" }, exists: () => false }).binaryPath).toBeNull();
  });
  it("allows an explicit absolute path in development and never searches PATH", () => {
    expect(resolveLocalTerminalRuntime({ ...base, isPackaged: false, env: { MATRIX_DESKTOP_HC_PATH: "/opt/hc" }, exists: () => false }).binaryPath).toBe("/opt/hc");
    expect(resolveLocalTerminalRuntime({ ...base, isPackaged: false, env: { MATRIX_DESKTOP_HC_PATH: "hc", PATH: "/usr/bin" }, exists: () => false }).binaryPath).toBeNull();
  });
  it("offers the bundled licence notices only when they ship inside the app", () => {
    const shipped = resolveLocalTerminalRuntime({ ...base, isPackaged: true, env: {}, exists: () => true });
    expect(shipped.noticesPath).toBe("/app/resources/herdr/NOTICES.txt");
    const dev = resolveLocalTerminalRuntime({ ...base, isPackaged: false, env: { MATRIX_DESKTOP_HC_PATH: "/opt/hc" }, exists: () => false });
    expect(dev.noticesPath).toBeNull();
  });
  it("keeps sockets in a short per-profile directory and state under userData", () => {
    const runtime = resolveLocalTerminalRuntime({ ...base, isPackaged: true, env: {}, exists: () => true });
    expect(runtime.runtimeDir).toMatch(/^\/Users\/neo\/\.matrixos\/dt\/[0-9a-f]{8}$/);
    expect(runtime.dataDir).toBe(`${base.userData}/herdr`);
    expect(resolveLocalTerminalRuntime({ ...base, userData: "/other", isPackaged: true, env: {}, exists: () => true }).runtimeDir).not.toBe(runtime.runtimeDir);
  });
});

// Every temporary directory a test makes is removed when that test ends.
const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("local terminal host preconditions", () => {
  const sink = { output: vi.fn(), closed: vi.fn() };
  function options(overrides: Partial<LocalTerminalHostOptions>): LocalTerminalHostOptions {
    const root = scratchDir("mx-host-");
    return { binaryPath: process.execPath, expectedVersion: LOCAL_TERMINAL_VERSION, runtimeDir: join(root, "r"), dataDir: join(root, "d"),
      home: root, shell: "/bin/sh", env: {}, uid: userInfo().uid,
      startCore: vi.fn(async () => { throw new Error("no core"); }), openSocket: (path) => connect(path), ...overrides };
  }
  it("reports not-installed, without starting anything, when no binary is installed", async () => {
    const opts = options({ binaryPath: null });
    const host = createLocalTerminalHost(opts, sink);
    await expect(host.list()).rejects.toThrow();
    expect(host.status()).toBe("not-installed");
    expect(opts.startCore).not.toHaveBeenCalled();
  });
  it("refuses directories owned by another user, for sockets and for state alike", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = options({ uid: userInfo().uid + 1 });
    const host = createLocalTerminalHost(opts, sink);
    await expect(host.list()).rejects.toThrow("not private");
    expect(host.status()).toBe("unavailable");
    expect(opts.startCore).not.toHaveBeenCalled();

    const state = options({});
    mkdirSync(state.dataDir); chmodSync(state.dataDir, 0o755);
    await expect(createLocalTerminalHost(state, sink).list()).rejects.toThrow("not private");
    expect(state.startCore).not.toHaveBeenCalled();
  });
  it("refuses a socket directory that is a symlink or open to other users", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const linked = options({});
    const target = scratchDir("mx-target-");
    symlinkSync(target, linked.runtimeDir);
    await expect(createLocalTerminalHost(linked, sink).list()).rejects.toThrow();
    expect(linked.startCore).not.toHaveBeenCalled();

    const open = options({});
    mkdirSync(open.runtimeDir); chmodSync(open.runtimeDir, 0o755);
    await expect(createLocalTerminalHost(open, sink).list()).rejects.toThrow();
    expect(open.startCore).not.toHaveBeenCalled();
  });
  it("refuses a socket path the operating system cannot hold", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = options({});
    const host = createLocalTerminalHost({ ...opts, runtimeDir: join(opts.home, "x".repeat(90)) }, sink);
    await expect(host.list()).rejects.toThrow();
    expect(opts.startCore).not.toHaveBeenCalled();
  });
  it("stops restarting a core that keeps failing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = options({});
    const host = createLocalTerminalHost(opts, sink);
    for (let attempt = 0; attempt < 5; attempt += 1) await host.list().catch(() => undefined);
    expect(opts.startCore).toHaveBeenCalledTimes(3);
  });
});

/** A socket on which nothing is listening, as the operating system reports it. */
function deadSocket(code: string) {
  const socket = new EventEmitter() as EventEmitter & { write(): void; destroy(): void };
  socket.write = () => undefined;
  socket.destroy = () => undefined;
  queueMicrotask(() => socket.emit("error", Object.assign(new Error(code), { code })));
  return socket;
}

describe("local terminal host against a scripted core", () => {
  type Call = { id: number; method: string; params: Record<string, unknown> };
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });

  function start(script: (core: ReturnType<typeof fakeCore>, call: Call) => void, overrides: Partial<LocalTerminalHostOptions> = {}) {
    const root = scratchDir("mx-host-");
    const cores: Array<ReturnType<typeof fakeCore>> = [];
    const sink = { output: vi.fn(), closed: vi.fn() };
    const opts: LocalTerminalHostOptions = {
      binaryPath: process.execPath, expectedVersion: LOCAL_TERMINAL_VERSION, runtimeDir: join(root, "r"), dataDir: join(root, "d"),
      home: root, shell: "/bin/zsh", uid: userInfo().uid,
      env: { HOME: root, PATH: "/usr/bin", GITHUB_TOKEN: "secret", MATRIX_API_ORIGIN: "x" },
      startCore: vi.fn(async () => undefined),
      openSocket: () => {
        const core = fakeCore();
        core.onCall((call) => script(core, call));
        cores.push(core);
        return core.socket;
      },
      ...overrides,
    };
    return { host: createLocalTerminalHost(opts, sink), sink, opts, cores, root };
  }
  const listing = (terminals: unknown[]) => (core: ReturnType<typeof fakeCore>, call: Call) => {
    if (call.method === "terminal.list") core.reply(call.id, { result: { terminals } });
  };

  it("lists live terminals with safe titles, and one malformed entry does not hide the rest", async () => {
    const { host } = start(listing([
      { address: "t1", state: "live", title: "\u202Egnp.exe\u0007 build", status: { state: "blocked", message: "free text" } },
      { address: "t2", state: "live", title: "x".repeat(5_000), status: { state: "made-up" } },
      { address: "t3", state: "live", title: 42, name: "named" },
      { address: "t4", state: "exited", title: "gone" },
      { address: "../../etc", state: "live" },
      "not an object",
    ]));
    expect(await host.list()).toEqual([
      { id: "t1", title: "gnp.exe build", status: "blocked" },
      { id: "t2", title: "x".repeat(256), status: null },
      { id: "t3", title: "named", status: null },
    ]);
    expect(host.status()).toBe("ready");
  });

  it("starts a core only when nothing is listening, and gives it the allowlisted environment", async () => {
    let dials = 0;
    const live = start(listing([]));
    const fresh = start(listing([]), { openSocket: () => (dials++ === 0 ? deadSocket("ENOENT") : live.opts.openSocket("")) });
    expect(await fresh.host.list()).toEqual([]);
    expect(fresh.opts.startCore).toHaveBeenCalledTimes(1);
    const env = vi.mocked(fresh.opts.startCore).mock.calls[0]![1];
    expect(env).toEqual({
      HOME: fresh.root, PATH: "/usr/bin", HC_SESSION: "mx",
      XDG_STATE_HOME: join(fresh.root, "d/state"), XDG_CONFIG_HOME: join(fresh.root, "d/config"), XDG_RUNTIME_DIR: join(fresh.root, "r"),
    });

    // A core that is there but refuses the connection is not started over.
    const refused = start(listing([]), { openSocket: () => deadSocket("EACCES") });
    await expect(refused.host.list()).rejects.toThrow();
    expect(refused.opts.startCore).not.toHaveBeenCalled();
    expect(refused.host.status()).toBe("unavailable");
  });

  it("starts the login shell without the core's own variables", async () => {
    const runs: Call[] = [];
    const { host } = start((core, call) => {
      if (call.method === "terminal.list") core.reply(call.id, { result: { terminals: [] } });
      if (call.method === "terminal.run") { runs.push(call); core.reply(call.id, { result: { address: "t7" } }); }
    });
    await expect(host.create({ cols: 100, rows: 30 })).resolves.toBe("t7");
    const argv = runs[0]!.params.argv as string[];
    expect(argv.slice(0, 1)).toEqual(["/usr/bin/env"]);
    for (const name of ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "HC_SESSION", "HC_TERMINAL_SOCKET"]) {
      expect(argv.join(" ")).toContain(`-u ${name}`);
    }
    expect(argv.slice(-2)).toEqual(["/bin/zsh", "-l"]);
    expect(Object.keys(runs[0]!.params.env as object).sort()).toEqual(["COLORTERM", "PATH", "TERM", "TERM_PROGRAM"]);
  });

  // Fault detected: an agent started from the window runs a command the renderer
  // chose, runs outside the user's home, or loses its login environment.
  it("starts a known agent through the login shell, in a folder under home only", async () => {
    const runs: Call[] = [];
    const { host, root } = start((core, call) => {
      if (call.method === "terminal.run") { runs.push(call); core.reply(call.id, { result: { address: "t8" } }); }
    });
    mkdirSync(join(root, "projects", "app"), { recursive: true });
    symlinkSync(tmpdir(), join(root, "escape"));
    await expect(host.create({ cols: 100, rows: 30 }, { agent: "codex", folder: "projects/app" })).resolves.toBe("t8");
    const argv = runs[0]!.params.argv as string[];
    expect(argv.slice(-6)).toEqual(["/bin/sh", "-c", '"$1" -l -i -c "$2"; exec "$1" -l', "matrix-agent", "/bin/zsh", "codex --no-daemon"]);
    expect(runs[0]!.params.cwd).toBe(realpathSync(join(root, "projects", "app")));
    expect(runs[0]!.params.labels).toEqual({ "matrix.agent": "codex" });
    await expect(host.create({ cols: 100, rows: 30 }, { folder: "escape" })).rejects.toThrow("not a folder in your home");
    await expect(host.create({ cols: 100, rows: 30 }, { folder: "missing" })).rejects.toThrow("not a folder in your home");
    expect(runs).toHaveLength(1);
  });

  it("renames through a label that wins over the program's title, and puts pasted files beside the terminal", async () => {
    const calls: Call[] = [];
    const { host } = start((core, call) => {
      calls.push(call);
      if (call.method === "terminal.label") core.reply(call.id, { result: {} });
      if (call.method === "terminal.put") core.reply(call.id, { result: { path: "/tmp/hc/t1/shot.png", bytes: 2 } });
      if (call.method === "terminal.list") {
        core.reply(call.id, { result: { terminals: [{ address: "t1", state: "live", title: "zsh", labels: { "matrix.title": "review\u202e" } }] } });
      }
    });
    await host.rename("t1", "review");
    await expect(host.put("t1", "shot.png", "aGk=")).resolves.toBe("/tmp/hc/t1/shot.png");
    await expect(host.list()).resolves.toEqual([{ id: "t1", title: "review", status: null }]);
    expect(calls.filter((call) => call.method !== "terminal.list").map((call) => [call.method, call.params])).toEqual([
      ["terminal.label", { terminal: "t1", labels: { "matrix.title": "review" } }],
      ["terminal.put", { terminal: "t1", name: "shot.png", data: "aGk=" }],
    ]);
  });

  it("limits how fast terminals are started, not how many exist", async () => {
    const terminals: unknown[] = Array.from({ length: 40 }, (_, index) => ({ address: `t${index + 1}`, state: "live" }));
    let time = 1_000_000;
    let runs = 0;
    const { host } = start((core, call) => {
      if (call.method === "terminal.list") core.reply(call.id, { result: { terminals: [...terminals] } });
      if (call.method === "terminal.run") {
        runs += 1;
        terminals.push({ address: `t${terminals.length + 1}`, state: "live" });
        core.reply(call.id, { result: { address: `t${terminals.length}` } });
      }
    }, { now: () => time });
    // Forty terminals already exist; that alone stops nothing.
    expect(await host.list()).toHaveLength(40);
    const burst = await Promise.all(Array.from({ length: 12 }, () => host.create({ cols: 80, rows: 24 })));
    expect(burst.filter((id) => id !== null)).toHaveLength(10);
    expect(burst.slice(10)).toEqual([null, null]);
    expect(runs).toBe(10);
    time += 10_001;
    await expect(host.create({ cols: 80, rows: 24 })).resolves.toBe("t51");
    expect(await host.list()).toHaveLength(51);
  });

  function attaching() {
    let channel = 10;
    const started = start((core, call) => {
      if (call.method === "terminal.attach") core.reply(call.id, { result: { channel: ++channel } });
    });
    return { ...started, lastChannel: () => channel };
  }

  it("returns flow-control credit only for output the window acknowledged", async () => {
    const { host, sink, cores, lastChannel } = attaching();
    const attachId = await host.attach("t1", { cols: 80, rows: 24 });
    const core = cores[0]!;
    core.stream(lastChannel(), HC_FRAME.DATA, Buffer.from("one"));
    core.stream(lastChannel(), HC_FRAME.DATA, Buffer.from("three"));
    expect(sink.output.mock.calls).toEqual([[attachId, "one"], [attachId, "three"]]);
    const credits = () => core.sent.frames.filter((frame) => frame.kind === HC_FRAME.CREDIT).map((frame) => frame.payload.readUInt32LE(0));
    expect(credits()).toEqual([]);
    expect(host.acknowledge(attachId, 1)).toBe(true);
    expect(credits()).toEqual([3]);
    expect(host.acknowledge(attachId, 50)).toBe(true);
    expect(credits()).toEqual([3, 5]);
    expect(host.acknowledge(attachId + 1, 1)).toBe(false);
  });

  it("frees every attachment when the window goes away, so a new window can attach again", async () => {
    const { host, sink, cores } = attaching();
    const first = await Promise.all(Array.from({ length: 8 }, () => host.attach("t1", { cols: 80, rows: 24 })));
    await expect(host.attach("t1", { cols: 80, rows: 24 })).rejects.toThrow("too many");
    host.detachAll();
    expect(cores[0]!.sent.frames.filter((frame) => frame.kind === HC_FRAME.CLOSE)).toHaveLength(8);
    // The window is gone: nothing is announced to it, and its ids are dead.
    expect(sink.closed).not.toHaveBeenCalled();
    expect(host.input(first[0]!, "ls", false)).toBe(false);
    expect(host.resize(first[0]!, { cols: 90, rows: 30 })).toBe(false);
    await expect(host.attach("t1", { cols: 80, rows: 24 })).resolves.toEqual(expect.any(Number));
  });

  it("does not complete an attach for a window that went away while the core was connecting", async () => {
    let connect!: () => void;
    const gate = new Promise<void>((resolve) => { connect = resolve; });
    const live = attaching();
    const slow = attaching();
    const host = createLocalTerminalHost({ ...slow.opts,
      // The first dial finds nothing; starting the core takes a while.
      openSocket: (() => { let dials = 0; return () => (dials++ === 0 ? deadSocket("ENOENT") : live.opts.openSocket("")); })(),
      startCore: vi.fn(async () => { await gate; }) }, slow.sink);
    const pending = host.attach("t1", { cols: 80, rows: 24 });
    const failure = expect(pending).rejects.toThrow("attachment ended");
    // The window reloads before the core is up.
    host.detachAll();
    connect();
    await failure;
    // Nothing was opened on the core for the departed window.
    expect(live.cores.flatMap((core) => core.sent.calls).filter((call) => call.method === "terminal.attach")).toEqual([]);
    // The next window attaches normally.
    await expect(host.attach("t1", { cols: 80, rows: 24 })).resolves.toEqual(expect.any(Number));
  });

  it("tells the window when a terminal ends or the core goes away, exactly once", async () => {
    const { host, sink, cores, lastChannel } = attaching();
    const ended = await host.attach("t1", { cols: 80, rows: 24 });
    const kept = await host.attach("t2", { cols: 80, rows: 24 });
    cores[0]!.stream(lastChannel() - 1, HC_FRAME.CLOSE, Buffer.alloc(0));
    expect(sink.closed.mock.calls).toEqual([[ended]]);
    cores[0]!.socket.emit("close");
    expect(sink.closed.mock.calls).toEqual([[ended], [kept]]);
  });

  it("fails an attach whose terminal ended while the core was still answering", async () => {
    const { host, sink } = start((core, call) => {
      if (call.method === "terminal.attach") core.socket.emit("data", Buffer.concat([
        core.replyBytes(call.id, { result: { channel: 4 } }), encodeFrame(4, HC_FRAME.CLOSE, Buffer.alloc(0)),
      ]));
    });
    await expect(host.attach("t1", { cols: 80, rows: 24 })).rejects.toThrow();
    expect(sink.closed).toHaveBeenCalledTimes(1);
    // Nothing is left attached for a dead terminal.
    expect(host.input(sink.closed.mock.calls[0]![0] as number, "x", false)).toBe(false);
  });
});

// The real pinned binary: an opt-in check of the same behaviour against
// herdr-core itself. It runs where a matching binary is installed (or
// MATRIX_DESKTOP_HC_PATH names one) and is skipped elsewhere; the scripted-core
// suite above is the one that always runs. Set MATRIX_DESKTOP_HC_REQUIRED=1 to
// fail instead of skip.
const candidates = [process.env.MATRIX_DESKTOP_HC_PATH, join(homedir(), ".local/bin/hc")].filter((path): path is string => !!path);
const binary = candidates.find((path) => {
  try { return existsSync(path) && execFileSync(path, ["--version"], { encoding: "utf8", timeout: 3_000 }).trim().endsWith(LOCAL_TERMINAL_VERSION); }
  catch { return false; }
});
if (process.env.MATRIX_DESKTOP_HC_REQUIRED === "1" && !binary) throw new Error(`herdr-core ${LOCAL_TERMINAL_VERSION} is required for this lane`);

(binary ? describe : describe.skip)("local terminals on the real herdr-core", () => {
  // A short path: Unix sockets cannot live under a long temporary directory.
  const root = binary ? mkdtempSync("/tmp/mxh-") : "";
  const base: LocalTerminalHostOptions = {
    binaryPath: binary!, expectedVersion: LOCAL_TERMINAL_VERSION, runtimeDir: join(root, "r"), dataDir: join(root, "d"),
    home: root, shell: "/bin/sh", uid: userInfo().uid,
    env: { HOME: root, PATH: "/usr/bin:/bin", USER: userInfo().username, MATRIX_SECRET_CANARY: "must-not-leak", ELECTRON_RUN_AS_NODE: "1" },
    startCore: startLocalTerminalCore, openSocket: (path) => connect(path),
  };
  const coreEnv = { HOME: root, PATH: "/usr/bin:/bin", HC_SESSION: "mx", XDG_STATE_HOME: join(root, "d/state"),
    XDG_CONFIG_HOME: join(root, "d/config"), XDG_RUNTIME_DIR: join(root, "r") };
  const outputs = new Map<number, string>();
  const closed: number[] = [];
  const sink = {
    // Acknowledge as a window would, so the core keeps sending.
    output: (id: number, data: string) => { outputs.set(id, (outputs.get(id) ?? "") + data); host.acknowledge(id, 1); },
    closed: (id: number) => { closed.push(id); },
  };
  const until = (read: () => boolean) => vi.waitFor(() => { if (!read()) throw new Error("waiting"); }, { timeout: 10_000, interval: 50 });
  let host = createLocalTerminalHost(base, sink);
  let terminalId = "";

  beforeAll(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterAll(() => {
    host.dispose();
    try { execFileSync(binary!, ["server", "stop"], { env: coreEnv, timeout: 5_000 }); }
    catch (error: unknown) { console.error("test core stop failed", error instanceof Error ? error.name : error); }
    rmSync(root, { recursive: true, force: true });
  });

  it("starts a private core and runs a shell whose environment is only the allowlist", async () => {
    const created = await host.create({ cols: 100, rows: 30 });
    expect(created).toMatch(/^t[0-9]+$/);
    terminalId = created!;
    expect(host.status()).toBe("ready");
    expect(statSync(join(root, "r")).mode & 0o077).toBe(0);
    expect(existsSync(join(root, "r/herdr-core/mx.sock"))).toBe(true);
    expect((await host.list()).map((terminal) => terminal.id)).toEqual([terminalId]);

    const attachId = await host.attach(terminalId, { cols: 100, rows: 30 });
    host.input(attachId, "echo MX_$((40+2)); env | sort | sed 's/^/E:/'; echo MX_DONE\r", false);
    // A line that is exactly MX_DONE: the echoed command line also contains the word.
    await until(() => /(^|\n)MX_DONE\r\n/.test(outputs.get(attachId) ?? ""));
    const text = outputs.get(attachId)!;
    expect(text).toContain("MX_42");
    const names = [...text.matchAll(/E:([A-Z_a-z0-9]+)=/g)].map((match) => match[1]!);
    expect(names).toEqual(expect.arrayContaining(["HOME", "PATH", "TERM"]));
    for (const name of names) expect(name, name).not.toMatch(/^(XDG_|HC_|MATRIX_|ELECTRON_|NODE_)/);
    host.detach(attachId);
  }, 30_000);

  it("runs matrix-status in the login shell and relays bounded status messages", async () => {
    const attachId = await host.attach(terminalId, { cols: 100, rows: 30 });
    host.input(attachId, 'matrix-status blocked "approve the migration?"\r', false);
    await vi.waitFor(async () => expect((await host.list()).find(terminal => terminal.id === terminalId)?.status).toBe("blocked"), { timeout: 10_000 });
    expect((await host.list()).find(terminal => terminal.id === terminalId)).toMatchObject({ status: "blocked", statusMessage: "approve the migration?" });
    host.input(attachId, 'matrix-status blocked "approve v2?"\r', false);
    await vi.waitFor(async () => expect((await host.list()).find(terminal => terminal.id === terminalId)?.statusMessage).toBe("approve v2?"), { timeout: 10_000 });
    host.detach(attachId);
  }, 30_000);

  it("keeps terminals running across an app restart and reattaches them", async () => {
    host.dispose();
    host = createLocalTerminalHost({ ...base, startCore: vi.fn(async () => { throw new Error("must reuse the running core"); }) }, sink);
    expect((await host.list()).map((terminal) => terminal.id)).toEqual([terminalId]);
    const attachId = await host.attach(terminalId, { cols: 100, rows: 30 });
    host.input(attachId, "echo STILL_$((1+1))\r", false);
    await until(() => (outputs.get(attachId) ?? "").includes("STILL_2"));
    host.resize(attachId, { cols: 120, rows: 40 });
    host.detach(attachId);
  }, 30_000);

  it("refuses a core of another version without creating terminals", async () => {
    const mismatched = createLocalTerminalHost({ ...base, expectedVersion: "9.9.9" }, sink);
    await expect(mismatched.create({ cols: 80, rows: 24 })).rejects.toThrow();
    expect(mismatched.status()).toBe("version-mismatch");
    mismatched.dispose();
    expect((await host.list()).map((terminal) => terminal.id)).toEqual([terminalId]);
  }, 30_000);

  it("ends a terminal on request and reports its stream closed", async () => {
    const attachId = await host.attach(terminalId, { cols: 100, rows: 30 });
    await host.kill(terminalId);
    await until(() => closed.includes(attachId));
    expect(await host.list()).toEqual([]);
  }, 30_000);
});
