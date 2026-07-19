import { EventEmitter } from "node:events";
import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  classifyZellijFailure,
  createZellijAdapter,
  sanitizeZellijError,
} from "../../packages/gateway/src/shell/zellij.js";
import { matrixTerminalShellScript } from "../../packages/gateway/src/shell/zellij-config.js";

const execFileAsync = promisify(nodeExecFile);

function childProcess() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

function ptyProcess() {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  return {
    writes: [] as string[],
    resize: vi.fn(),
    kill: vi.fn(),
    write(data: string) {
      this.writes.push(data);
    },
    onData(listener: (data: string) => void) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    emitData(data: string) {
      for (const listener of dataListeners) listener(data);
    },
    emitExit(exitCode: number, signal?: number) {
      for (const listener of exitListeners) listener({ exitCode, signal });
    },
  };
}

describe("zellij adapter", () => {
  it("uses execFile with argument arrays and bounded timeouts", async () => {
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "main\n", "");
      return child;
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await expect(adapter.listSessions()).resolves.toEqual(["main"]);
    expect(execFile).toHaveBeenCalledWith(
      "zellij",
      ["list-sessions", "--no-formatting"],
      expect.objectContaining({ timeout: 25, signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
  });

  it("checks backend health with bounded zellij --version", async () => {
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "zellij 0.44.1\n", "");
      return child;
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await expect(adapter.health()).resolves.toEqual({ ok: true, code: "ok" });
    expect(execFile).toHaveBeenCalledWith(
      "zellij",
      ["--version"],
      expect.objectContaining({ timeout: 25, signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
  });

  it("reads the focused terminal pane cwd from bounded structured zellij queries", async () => {
    const execFile = vi.fn((_file, args: string[], _opts, cb) => {
      const stdout = args.includes("current-tab-info")
        ? JSON.stringify({ tab_id: 4, active: true })
        : JSON.stringify([
          { id: 1, is_plugin: false, is_focused: true, tab_id: 2, pane_cwd: "/home/alice/other" },
          { id: 2, is_plugin: false, is_focused: true, tab_id: 4, pane_cwd: "/home/alice/project" },
          { id: 3, is_plugin: true, is_focused: false, tab_id: 4, pane_cwd: null },
        ]);
      cb(null, stdout, "");
      return childProcess();
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await expect(adapter.focusedPaneCwd("main")).resolves.toBe("/home/alice/project");
    await expect(adapter.focusedPaneCwd("main")).resolves.toBe("/home/alice/project");
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenCalledWith(
      "zellij",
      ["--session", "main", "action", "list-panes", "--all", "--json"],
      expect.objectContaining({ timeout: 25, signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
  });

  it("treats zellij's no-active-sessions response as an empty session list", async () => {
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(Object.assign(new Error("zellij exited"), { code: 1 }), "", "NO ACTIVE ZELLIJ SESSIONS FOUND\n");
      return childProcess();
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await expect(adapter.listSessions()).resolves.toEqual([]);
  });

  it("sanitizes stderr before surfacing execFile errors", async () => {
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(new Error("boom"), "", "failed in /home/alice/.ssh with zellij internals");
      return childProcess();
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await expect(adapter.createTab("main", { name: "tools" })).rejects.toMatchObject({
      code: "zellij_failed",
      safeMessage: "Shell operation failed",
    });
  });

  it("classifies a missing zellij binary during session creation for server diagnostics", async () => {
    const missing = Object.assign(new Error("spawn zellij ENOENT"), {
      code: "ENOENT",
      syscall: "spawn zellij",
    });
    const spawnPty = vi.fn(() => {
      throw missing;
    });
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25 });

    await expect(adapter.createSession({ name: "main" })).rejects.toMatchObject({
      code: "zellij_failed",
      diagnostic: {
        binary: "zellij",
        kind: "binary_not_found",
      },
    });
  });

  it("classifies zellij timeouts without exposing stderr", () => {
    const timedOut = Object.assign(new Error("Command timed out"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
    });

    expect(classifyZellijFailure(timedOut, "details from /home/alice/project")).toEqual({
      binary: "zellij",
      kind: "timeout",
      signal: "SIGTERM",
      stderr: "details from [path]",
    });
  });

  it("keeps errno strings separate from process exit codes", () => {
    const missing = Object.assign(new Error("spawn zellij ENOENT"), {
      code: "ENOENT",
    });
    const failed = Object.assign(new Error("zellij exited"), {
      code: 1,
    });

    expect(classifyZellijFailure(missing, "")).toEqual({
      binary: "zellij",
      errorCode: "ENOENT",
      kind: "binary_not_found",
    });
    expect(classifyZellijFailure(failed, "")).toEqual({
      binary: "zellij",
      exitCode: 1,
      kind: "process_failed",
    });
  });

  it("starts attach through a PTY with a scrubbed zellij environment", () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => pty);
    const controller = new AbortController();
    const adapter = createZellijAdapter({
      execFile: vi.fn(),
      spawnPty,
      timeoutMs: 25,
      env: {
        HOME: "/home/matrix",
        PATH: "/opt/matrix/bin",
        TERM: "screen-256color",
        XDG_RUNTIME_DIR: "/run/user/999",
        ZELLIJ: "0",
        ZELLIJ_CONFIG_DIR: "/home/matrix/.config/zellij",
        ZELLIJ_CONFIG_FILE: "/home/matrix/.config/zellij/config.kdl",
        ZELLIJ_SESSION_NAME: "main",
        ZELLIJ_PANE_ID: "1",
        ZELLIJ_SOCKET_DIR: "/run/user/999/zellij",
        LANG: "fr_FR.UTF-8",
        SECRET_TOKEN: "nope",
      },
      cwd: "/opt/matrix/app",
    });

    adapter.attachSession("main", { signal: controller.signal });

    expect(spawnPty).toHaveBeenCalledWith(
      "zellij",
      ["attach", "main"],
      expect.objectContaining({
        cols: 120,
        rows: 40,
        name: "xterm-256color",
        cwd: "/opt/matrix/app",
        env: expect.objectContaining({
          HOME: "/home/matrix",
          PATH: "/opt/matrix/bin",
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          CLICOLOR: "1",
          FORCE_COLOR: "3",
          COLORFGBG: "15;0",
          LANG: "fr_FR.UTF-8",
          XDG_RUNTIME_DIR: "/run/user/999",
          ZELLIJ_CONFIG_DIR: "/home/matrix/.config/zellij",
          ZELLIJ_CONFIG_FILE: "/home/matrix/.config/zellij/config.kdl",
          ZELLIJ_SOCKET_DIR: "/run/user/999/zellij",
        }),
      }),
    );
    const env = spawnPty.mock.calls[0]?.[2].env;
    expect(env).not.toHaveProperty("ZELLIJ");
    expect(env).not.toHaveProperty("ZELLIJ_SESSION_NAME");
    expect(env).not.toHaveProperty("ZELLIJ_PANE_ID");
    expect(env).not.toHaveProperty("LC_ALL");
    expect(env).not.toHaveProperty("SECRET_TOKEN");
  });

  it("uses the Matrix owner home for shells when a home path is configured", () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => pty);
    const adapter = createZellijAdapter({
      execFile: vi.fn(),
      spawnPty,
      homePath: "/srv/matrix/home",
      env: {
        HOME: "/Users/developer",
        PATH: "/opt/matrix/bin",
      },
    });

    adapter.attachSession("main");

    expect(spawnPty).toHaveBeenCalledWith(
      "zellij",
      ["attach", "main"],
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: "/srv/matrix/home",
          MATRIX_HOME: "/srv/matrix/home",
        }),
      }),
    );
  });

  it("kills attach PTYs when the caller aborts", () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => pty);
    const controller = new AbortController();
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25 });

    adapter.attachSession("main", { signal: controller.signal });
    controller.abort();

    expect(pty.kill).toHaveBeenCalled();
  });

  it("attaches through a PTY so input, output, exit, and resize behave like a real terminal", () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => pty);
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25 });

    const attached = adapter.attachSession("setup");
    attached.write("claude\r");
    attached.resize(140, 50);
    pty.emitData("ready");
    pty.emitExit(0);

    expect(spawnPty).toHaveBeenCalledWith(
      "zellij",
      ["attach", "setup"],
      expect.objectContaining({ name: "xterm-256color", cols: 120, rows: 40 }),
    );
    expect(pty.writes).toEqual(["claude\r"]);
    expect(pty.resize).toHaveBeenCalledWith(140, 50);
  });

  it("sends one-shot input through the zellij action API", async () => {
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "", "");
      return child;
    });
    const spawnPty = vi.fn();
    const adapter = createZellijAdapter({ execFile, spawnPty, timeoutMs: 25 });

    await adapter.sendInput("main", "pwd\r");

    expect(spawnPty).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledWith(
      "zellij",
      ["--session", "main", "action", "write-chars", "--", "pwd\r"],
      expect.objectContaining({ timeout: 25, signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
  });

  it("rejects one-shot input when the zellij action fails", async () => {
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(new Error("boom"), "", "failed in /home/alice/project");
      return child;
    });
    const adapter = createZellijAdapter({ execFile, spawnPty: vi.fn(), timeoutMs: 25 });

    await expect(adapter.sendInput("main", "pwd\r")).rejects.toMatchObject({
      code: "zellij_failed",
      safeMessage: "Shell operation failed",
    });
  });

  it("creates sessions in the requested cwd using a retained PTY", async () => {
    const pty = ptyProcess();
    const execFile = vi.fn();
    const spawnPty = vi.fn(() => pty);
    const adapter = createZellijAdapter({
      execFile,
      spawnPty,
      timeoutMs: 25,
      startupDelayMs: 1,
    });

    await adapter.createSession({ name: "main", cwd: "/home/alice/work" });

    expect(execFile).not.toHaveBeenCalled();
    expect(spawnPty).toHaveBeenCalledWith(
      "zellij",
      ["--session", "main"],
      expect.objectContaining({
        cwd: "/home/alice/work",
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        env: expect.objectContaining({
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          CLICOLOR: "1",
          FORCE_COLOR: "3",
          COLORFGBG: "15;0",
        }),
      }),
    );
  });

  it("writes and uses chrome-free Matrix zellij config and layout for shell sessions", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-shell-zellij-"));
    try {
      const pty = ptyProcess();
      const spawnPty = vi.fn(() => pty);
      const adapter = createZellijAdapter({
        execFile: vi.fn(),
        spawnPty,
        timeoutMs: 25,
        startupDelayMs: 1,
        homePath,
      });

      await adapter.createSession({ name: "main", cwd: "/home/matrix/home/projects" });

      const configDir = join(homePath, "system", "zellij");
      const configPath = join(configDir, "config.kdl");
      const layoutPath = join(configDir, "layouts", "matrix.kdl");
      const shellPath = join(configDir, "matrix-terminal-shell");
      const zshenvPath = join(configDir, ".zshenv");
      const zshrcPath = join(configDir, ".zshrc");
      const bashrcPath = join(configDir, "bashrc");
      const promptLabelPath = join(configDir, "prompt-label.mjs");
      const config = await readFile(configPath, "utf8");
      const layout = await readFile(layoutPath, "utf8");
      const shell = await readFile(shellPath, "utf8");
      const zshenv = await readFile(zshenvPath, "utf8");
      const zshrc = await readFile(zshrcPath, "utf8");
      const bashrc = await readFile(bashrcPath, "utf8");
      const promptLabel = await readFile(promptLabelPath, "utf8");
      const shellMode = (await stat(shellPath)).mode;

      expect(config).toContain("pane_frames false");
      expect(config).toContain("simplified_ui true");
      expect(config).toContain("hide_session_name true");
      expect(config).toContain('default_layout "matrix"');
      expect(config).toContain(`default_shell ${JSON.stringify(shellPath)}`);
      expect(shell).toContain(`export ZDOTDIR='${configDir}'`);
      expect(shell).toContain('matrix_zsh="$(command -v zsh 2>/dev/null || true)"');
      expect(shell).toContain('export SHELL="$matrix_zsh"');
      expect(shell).toContain('exec "$matrix_zsh" -d -i');
      expect(shell).toContain("exec bash --noprofile --rcfile");
      expect(shell).toContain('matrix_prepend_terminal_path "$MATRIX_HOME/.local/bin"');
      expect(shell).toContain('matrix_prepend_terminal_path "${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}/bin"');
      expect(shell).toContain('if [ "$#" -gt 0 ]; then');
      expect(shell).toContain('  set +e\n  ( "$@" )\n  set -e');
      expect(shell.indexOf('matrix_zsh="$(command -v zsh')).toBeLessThan(shell.indexOf('if [ "$#" -gt 0 ]; then'));
      expect(shell.indexOf('export SHELL="$matrix_zsh"')).toBeLessThan(shell.indexOf('if [ "$#" -gt 0 ]; then'));
      expect(shell.indexOf('matrix_bash="$(command -v bash')).toBeLessThan(shell.indexOf('if [ "$#" -gt 0 ]; then'));
      expect(shell.indexOf('export SHELL="$matrix_bash"')).toBeLessThan(shell.indexOf('if [ "$#" -gt 0 ]; then'));
      expect(shell).toContain(`node '${promptLabelPath}'`);
      expect(shell).toContain('if [ -z "${MATRIX_TERMINAL_PROMPT:-}" ] && command -v node >/dev/null 2>&1; then');
      expect(shell).not.toContain("/bin/zsh");
      expect(shellMode & 0o700).toBe(0o700);
      expect(zshenv).toContain('if [ -r "$HOME/.zshenv" ]; then');
      expect(zshenv).toContain('. "$HOME/.zshenv"');
      expect(zshenv).toContain('matrix_terminal_owner_zdotdir="${ZDOTDIR:-$HOME}"');
      expect(zshrc).not.toContain('$HOME/.zshenv');
      expect(zshrc).toContain('matrix_terminal_owner_zdotdir="${matrix_terminal_owner_zdotdir:-$HOME}"');
      expect(zshrc).toContain('[ -r "$matrix_terminal_owner_zdotdir/.zshrc" ]; then');
      expect(zshrc).toContain('. "$matrix_terminal_owner_zdotdir/.zshrc"');
      expect(zshrc).not.toContain('if [ -r "$HOME/.zshrc" ]; then');
      expect(zshrc).toContain('matrix_prepend_terminal_path "${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}/bin"');
      expect(zshrc).toContain('if [ -n "${MATRIX_HOME:-}" ]; then');
      expect(zshrc).toContain('matrix_prepend_terminal_path "$MATRIX_HOME/.local/bin"');
      expect(zshrc).toContain('PROMPT="${MATRIX_TERMINAL_PROMPT}"');
      expect(zshrc).toContain("%n:%~%# ");
      expect(zshrc).toContain("add-zsh-hook precmd matrix_terminal_apply_prompt");
      expect(bashrc).toContain('PS1="${MATRIX_TERMINAL_PROMPT}"');
      expect(promptLabel).toContain("JSON.parse");
      expect(config).toContain('theme "default"');
      expect(config).not.toContain("matrix-dark {");
      expect(config).not.toContain("matrix-light {");
      expect(config).toContain("matrix {");
      expect(layout).not.toContain("compact-bar");
      expect(layout).not.toContain("tab-bar");
      expect(layout).not.toContain("status-bar");
      expect(spawnPty).toHaveBeenCalledWith(
        "zellij",
        ["--session", "main", "--new-session-with-layout", layoutPath],
        expect.objectContaining({
          env: expect.objectContaining({
            ZELLIJ_CONFIG_DIR: configDir,
            ZELLIJ_CONFIG_FILE: configPath,
          }),
        }),
      );
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("derives prompt labels from owner handle.json without shell injection", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-shell-prompt-label-"));
    try {
      const systemDir = join(homePath, "system");
      await mkdir(systemDir, { recursive: true });
      const handlePath = join(systemDir, "handle.json");
      await writeFile(handlePath, JSON.stringify({
        handle: "hamedmp",
        displayName: "Hamed MP",
      }));

      const pty = ptyProcess();
      const spawnPty = vi.fn(() => pty);
      const adapter = createZellijAdapter({
        execFile: vi.fn(),
        spawnPty,
        timeoutMs: 25,
        startupDelayMs: 1,
        homePath,
      });

      await adapter.createSession({ name: "main" });

      const promptLabelPath = join(homePath, "system", "zellij", "prompt-label.mjs");
      await expect(execFileAsync(process.execPath, [promptLabelPath], {
        env: { ...process.env, MATRIX_HOME: homePath },
        timeout: 1_000,
      })).resolves.toMatchObject({ stdout: "hamedmp" });

      await writeFile(handlePath, JSON.stringify({
        handle: "bad$(rm -rf /)",
        displayName: "Hamed MP",
      }));
      await expect(execFileAsync(process.execPath, [promptLabelPath], {
        env: { ...process.env, MATRIX_HOME: homePath },
        timeout: 1_000,
      })).resolves.toMatchObject({ stdout: "Hamed-MP" });

      await writeFile(handlePath, JSON.stringify({
        handle: "bad\\label",
        displayName: "bad\u001b[31m",
      }));
      await expect(execFileAsync(process.execPath, [promptLabelPath], {
        env: { ...process.env, MATRIX_HOME: homePath },
        timeout: 1_000,
      })).resolves.toMatchObject({ stdout: "" });

      await writeFile(handlePath, "{not-json");
      await expect(execFileAsync(process.execPath, [promptLabelPath], {
        env: { ...process.env, MATRIX_HOME: homePath },
        timeout: 1_000,
      })).resolves.toMatchObject({
        stdout: "",
        stderr: expect.stringContaining("[matrix-terminal-prompt] unable to read owner identity"),
      });

      await rm(handlePath, { force: true });
      await expect(execFileAsync(process.execPath, [promptLabelPath], {
        env: { ...process.env, MATRIX_HOME: homePath },
        timeout: 1_000,
      })).resolves.toMatchObject({ stdout: "", stderr: "" });
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("creates command sessions with the command as the initial focused pane", async () => {
    const pty = ptyProcess();
    let layoutPath: string | undefined;
    let layoutText = "";
    const homePath = await mkdtemp(join(tmpdir(), "matrix-shell-command-home-"));
    const spawnPty = vi.fn((_command, args) => {
      layoutPath = String(args[3]);
      layoutText = readFileSync(layoutPath, "utf8");
      return pty;
    });
    try {
      const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25, startupDelayMs: 1, homePath });

      await adapter.createSession({
        name: "bench",
        cwd: "/home/alice/work",
        cmd: "node -e 'process.stdout.write(\"MATRIX_BENCH_READY\\n\")'",
      });

      expect(spawnPty).toHaveBeenCalledTimes(1);
      const args = spawnPty.mock.calls[0]?.[1];
      expect(args).toEqual([
        "--session",
        "bench",
        "--new-session-with-layout",
        expect.stringMatching(/matrix-zellij-layout-/),
      ]);
      expect(layoutText).toContain('cwd="/home/alice/work"');
      expect(layoutText).toContain(`command="${homePath}/system/zellij/matrix-terminal-shell"`);
      expect(layoutText).toContain('args "node" "-e"');
      expect(layoutText).toContain("MATRIX_BENCH_READY");
      expect(layoutText).not.toContain('command="node"');
      expect(layoutText).toContain('tab name="main"');
      expect(layoutText).not.toContain("compact-bar");
      expect(layoutText).not.toContain("tab-bar");
      expect(layoutText).not.toContain("status-bar");
      expect(layoutPath).toEqual(expect.any(String));
      expect(existsSync(layoutPath!)).toBe(true);

      pty.emitExit(0);
      await vi.waitFor(() => {
        expect(existsSync(layoutPath!)).toBe(false);
      });
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("rejects session creation when the retained PTY exits during startup", async () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => {
      setTimeout(() => pty.emitExit(1), 0);
      return pty;
    });
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25, startupDelayMs: 10 });

    await expect(adapter.createSession({ name: "broken" })).rejects.toMatchObject({
      code: "zellij_failed",
      safeMessage: "Shell operation failed",
      diagnostic: {
        binary: "zellij",
        kind: "process_failed",
        exitCode: 1,
      },
    });
  });

  it("preserves numeric PTY signals in startup failure diagnostics", async () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => {
      setTimeout(() => pty.emitExit(0, 15), 0);
      return pty;
    });
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25, startupDelayMs: 10 });

    await expect(adapter.createSession({ name: "signaled" })).rejects.toMatchObject({
      code: "zellij_failed",
      diagnostic: {
        binary: "zellij",
        kind: "process_failed",
        exitCode: 0,
        signal: "15",
      },
    });
  });

  it("kills retained creation PTYs when deleting sessions", async () => {
    const pty = ptyProcess();
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "", "");
      return child;
    });
    const spawnPty = vi.fn(() => pty);
    const adapter = createZellijAdapter({ execFile, spawnPty, timeoutMs: 25, startupDelayMs: 1 });

    await adapter.createSession({ name: "main" });
    await adapter.deleteSession("main", { force: true });

    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      "zellij",
      ["delete-session", "main", "--force"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("evicts the oldest retained creation PTY when the cap is reached", async () => {
    const first = ptyProcess();
    const second = ptyProcess();
    const spawnPty = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const adapter = createZellijAdapter({
      execFile: vi.fn(),
      spawnPty,
      timeoutMs: 25,
      startupDelayMs: 1,
      maxRetainedPtys: 1,
    });

    await adapter.createSession({ name: "first" });
    await adapter.createSession({ name: "second" });

    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(second.kill).not.toHaveBeenCalled();
  });

  it("creates tabs and panes with terminal-capable environment at process launch", async () => {
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "", "");
      return child;
    });
    const adapter = createZellijAdapter({
      execFile,
      spawn: vi.fn(),
      timeoutMs: 25,
      env: { TERM: "dumb", COLORTERM: "", PATH: "/usr/bin" },
    });

    await adapter.createTab("main", { name: "tools" });
    await adapter.splitPane("main", { direction: "right" });

    for (const call of execFile.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({
        env: expect.objectContaining({
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          CLICOLOR: "1",
          FORCE_COLOR: "3",
          COLORFGBG: "15;0",
        }),
      }));
    }
  });

  it("splits multi-word commands into argv tokens for zellij actions", async () => {
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "", "");
      return child;
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await adapter.createTab("main", { cmd: "bun run test" });
    await adapter.splitPane("main", { direction: "down", cmd: "tail -f '/tmp/my log'" });

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "zellij",
      ["--session", "main", "action", "new-tab", "--", "bun", "run", "test"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      "zellij",
      ["--session", "main", "action", "new-pane", "--down", "--", "tail", "-f", "/tmp/my log"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("redacts paths from zellij stderr", () => {
    expect(sanitizeZellijError("bad /home/alice/projects/app and /tmp/file")).toBe(
      "bad [path] and [path]",
    );
  });

  it("shell-quotes generated shell config paths", () => {
    const zshrcPath = `/tmp/matrix "owner"/it'works/.zshrc`;
    const bashrcPath = `/tmp/matrix "owner"/it'works/bashrc`;
    const promptLabelPath = `/tmp/matrix "owner"/it'works/prompt-label.mjs`;
    const script = matrixTerminalShellScript(zshrcPath, bashrcPath, promptLabelPath);

    expect(script).toContain(`exec bash --noprofile --rcfile '/tmp/matrix "owner"/it'\\''works/bashrc' -i`);
    expect(script).toContain(`export ZDOTDIR='/tmp/matrix "owner"/it'\\''works'`);
    expect(script).toContain('  ( "$@" )');
    expect(script).toContain(`node '/tmp/matrix "owner"/it'\\''works/prompt-label.mjs'`);
    expect(script).not.toContain("/bin/bash");
    expect(script.indexOf('  ( "$@" )')).toBeLessThan(script.indexOf('exec "$matrix_zsh" -d -i'));
  });
});
