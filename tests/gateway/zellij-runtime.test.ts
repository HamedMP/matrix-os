import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZellijRuntime } from "../../packages/gateway/src/zellij-runtime.js";
import type { AgentLaunchSpec } from "../../packages/gateway/src/agent-launcher.js";

function createPty() {
  const handlers: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  return {
    process: {
      kill: vi.fn(),
      onExit: vi.fn((handler: (event: { exitCode: number; signal?: number }) => void) => {
        handlers.push(handler);
        return { dispose: vi.fn() };
      }),
    },
    exit(event: { exitCode: number; signal?: number }) {
      for (const handler of handlers) handler(event);
    },
  };
}

describe("zellij-runtime", () => {
  let homePath: string;
  const launch: AgentLaunchSpec = {
    command: "codex",
    args: ["--sandbox", "workspace-write", "--", "fix tests; rm -rf /"],
    cwd: "/home/matrixos/home/projects/repo/worktrees/wt_123",
    env: {},
  };

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-zellij-runtime-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("writes a generated layout under the Matrix home without shell interpolation", async () => {
    const runtime = createZellijRuntime({ homePath, runCommand: vi.fn() });

    const result = await runtime.generateLayout({ sessionId: "sess_abc123", launch });

    expect(result.layoutPath).toBe(join(homePath, "system", "zellij", "layouts", "sess_abc123.kdl"));
    const layout = await readFile(result.layoutPath, "utf-8");
    expect(layout).toContain('pane cwd="/home/matrixos/home/projects/repo/worktrees/wt_123" command="codex" {');
    expect(layout).toContain('args "--sandbox" "workspace-write" "--" "fix tests; rm -rf /"');
    expect(layout).not.toContain('pane cwd "');
    expect(layout).not.toContain('command "codex" {');
    expect(layout).not.toContain("sh -c");
  });

  it("starts zellij through a retained PTY, then attaches, observes, and kills by argv", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "ok\n", stderr: "" }));
    const pty = createPty();
    const spawnPty = vi.fn(() => pty.process);
    const runtime = createZellijRuntime({ homePath, runCommand, spawnPty, startupDelayMs: 1 });

    const started = await runtime.start({ sessionId: "sess_abc123", launch });
    expect(started).toMatchObject({
      ok: true,
      sessionName: "matrix-sess_abc123",
      status: "running",
    });
    expect(spawnPty).toHaveBeenCalledWith(
      "zellij",
      ["--session", "matrix-sess_abc123", "--new-session-with-layout", started.layoutPath],
      expect.objectContaining({
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: launch.cwd,
        env: expect.objectContaining({
          ...launch.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          CLICOLOR: "1",
          FORCE_COLOR: "3",
          COLORFGBG: "15;0",
        }),
      }),
    );
    expect(runCommand).not.toHaveBeenCalledWith("zellij", expect.arrayContaining(["--layout"]), expect.any(Object));

    expect(runtime.attachCommand("sess_abc123")).toEqual(["zellij", "attach", "matrix-sess_abc123"]);
    expect(runtime.observeCommand("sess_abc123")).toEqual(["zellij", "attach", "matrix-sess_abc123", "--index", "0"]);

    await expect(runtime.kill("sess_abc123")).resolves.toEqual({ ok: true });
    expect(pty.process.kill).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(
      "zellij",
      ["kill-session", "matrix-sess_abc123"],
      expect.any(Object),
    );
  });

  it("sends bounded input to one deterministic session with the caller signal", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const runtime = createZellijRuntime({ homePath, runCommand });
    const signal = AbortSignal.timeout(1_000);

    await runtime.sendInput("sess_abc123", "Continue with the fix.\r", signal);

    expect(runCommand).toHaveBeenCalledWith(
      "zellij",
      ["--session", "matrix-sess_abc123", "action", "write-chars", "--", "Continue with the fix.\r"],
      expect.objectContaining({
        cwd: homePath,
        timeout: 10_000,
        signal,
      }),
    );
  });

  it("writes chrome-free Matrix zellij config and starts with that config environment", async () => {
    const pty = createPty();
    const spawnPty = vi.fn(() => pty.process);
    const runtime = createZellijRuntime({ homePath, runCommand: vi.fn(), spawnPty, startupDelayMs: 1 });

    const started = await runtime.start({ sessionId: "sess_matrix_ui", launch });

    const configDir = join(homePath, "system", "zellij");
    const configPath = join(configDir, "config.kdl");
    const shellPath = join(configDir, "matrix-terminal-shell");
    const zshrcPath = join(configDir, ".zshrc");
    const promptLabelPath = join(configDir, "prompt-label.mjs");
    const config = await readFile(configPath, "utf-8");
    const shell = await readFile(shellPath, "utf-8");
    const zshrc = await readFile(zshrcPath, "utf-8");
    const promptLabel = await readFile(promptLabelPath, "utf-8");
    const defaultLayout = await readFile(join(configDir, "layouts", "matrix.kdl"), "utf-8");
    const sessionLayout = await readFile(started.layoutPath, "utf-8");

    expect(config).toContain("pane_frames false");
    expect(config).toContain("simplified_ui true");
    expect(config).toContain("hide_session_name true");
    expect(config).toContain('default_layout "matrix"');
    expect(config).toContain(`default_shell ${JSON.stringify(shellPath)}`);
    expect(shell).toContain(`export ZDOTDIR='${configDir}'`);
    expect(shell).toContain('export SHELL="$matrix_zsh"');
    expect(shell).toContain('exec "$matrix_zsh" -d -i');
    expect(shell).toContain("exec bash --noprofile --rcfile");
    expect(shell).toContain(`node '${promptLabelPath}'`);
    expect(zshrc).toContain('PROMPT="${MATRIX_TERMINAL_PROMPT}"');
    expect(promptLabel).toContain("handle.json");
    expect(config).toContain('theme "default"');
    expect(config).not.toContain("matrix-dark {");
    expect(config).not.toContain("matrix-light {");
    expect(config).toContain("matrix {");
    expect(defaultLayout).not.toContain("compact-bar");
    expect(defaultLayout).not.toContain("tab-bar");
    expect(defaultLayout).not.toContain("status-bar");
    expect(sessionLayout).not.toContain("compact-bar");
    expect(sessionLayout).not.toContain("tab-bar");
    expect(sessionLayout).not.toContain("status-bar");
    expect(spawnPty).toHaveBeenCalledWith(
      "zellij",
      ["--session", "matrix-sess_matrix_ui", "--new-session-with-layout", started.layoutPath],
      expect.objectContaining({
        env: expect.objectContaining({
          ZELLIJ_CONFIG_DIR: configDir,
          ZELLIJ_CONFIG_FILE: configPath,
        }),
      }),
    );
  });

  it("passes only safe process environment keys plus explicit launch env to zellij", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://secret");
    vi.stubEnv("LINEAR_API_KEY", "lin_api_secret");
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("LC_ALL", "C.UTF-8");
    const pty = createPty();
    const spawnPty = vi.fn(() => pty.process);
    const runtime = createZellijRuntime({ homePath, runCommand: vi.fn(), spawnPty, startupDelayMs: 1 });

    await runtime.start({
      sessionId: "sess_env",
      launch: { ...launch, env: { MATRIX_EXPLICIT: "allowed" } },
    });

    const env = spawnPty.mock.calls[0]?.[2].env;
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      MATRIX_EXPLICIT: "allowed",
    });
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("LINEAR_API_KEY");
  });

  it("evicts stale retained PTYs before starting another session", async () => {
    let nowMs = 0;
    const oldPty = createPty();
    const newPty = createPty();
    const spawnPty = vi.fn()
      .mockReturnValueOnce(oldPty.process)
      .mockReturnValueOnce(newPty.process);
    const runtime = createZellijRuntime({
      homePath,
      runCommand: vi.fn(),
      spawnPty,
      startupDelayMs: 1,
      retainedPtyTtlMs: 10,
      nowMs: () => nowMs,
    });

    await runtime.start({ sessionId: "sess_old", launch });
    nowMs = 11;
    await runtime.start({ sessionId: "sess_new", launch });

    expect(oldPty.process.kill).toHaveBeenCalledTimes(1);
    expect(newPty.process.kill).not.toHaveBeenCalled();
  });

  it("fails startup if the zellij PTY exits before the startup delay", async () => {
    const pty = createPty();
    const spawnPty = vi.fn(() => {
      setTimeout(() => pty.exit({ exitCode: 1 }), 0);
      return pty.process;
    });
    const runtime = createZellijRuntime({ homePath, runCommand: vi.fn(), spawnPty, startupDelayMs: 10 });

    await expect(runtime.start({ sessionId: "sess_exits", launch })).rejects.toThrow("zellij_start_failed");
  });

  it("lets kill reach a session during the startup delay", async () => {
    const pty = createPty();
    const runCommand = vi.fn(async () => ({ stdout: "ok\n", stderr: "" }));
    let runtime: ReturnType<typeof createZellijRuntime>;
    const spawnPty = vi.fn(() => {
      setTimeout(() => void runtime.kill("sess_cancel"), 0);
      return pty.process;
    });
    runtime = createZellijRuntime({ homePath, runCommand, spawnPty, startupDelayMs: 10 });

    await expect(runtime.start({ sessionId: "sess_cancel", launch })).rejects.toThrow("zellij_start_cancelled");
    expect(pty.process.kill).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(
      "zellij",
      ["kill-session", "matrix-sess_cancel"],
      expect.any(Object),
    );
  });

  it("escapes newlines, tabs, and control characters in KDL layout strings", async () => {
    const runtime = createZellijRuntime({ homePath, runCommand: vi.fn() });
    const launchWithControlChars: AgentLaunchSpec = {
      command: "claude",
      args: ["--", "line1\nline2\ttabbed\r\x00null\x07bel"],
      cwd: "/home/matrixos/home/projects/repo",
      env: {},
    };

    const result = await runtime.generateLayout({ sessionId: "sess_esc1", launch: launchWithControlChars });
    const layout = await readFile(result.layoutPath, "utf-8");

    expect(layout).toContain("\\n");
    expect(layout).toContain("\\t");
    expect(layout).toContain("\\r");
    expect(layout).not.toContain("\x00");
    expect(layout).not.toContain("\x07");
    expect(layout).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
  });

  it("preserves KDL string integrity when prompt contains quote-escape sequences", async () => {
    const runtime = createZellijRuntime({ homePath, runCommand: vi.fn() });
    const launchWithQuotes: AgentLaunchSpec = {
      command: "claude",
      args: ["--", 'say "hello" and use \\backslash'],
      cwd: "/home/matrixos/home/projects/repo",
      env: {},
    };

    const result = await runtime.generateLayout({ sessionId: "sess_esc2", launch: launchWithQuotes });
    const layout = await readFile(result.layoutPath, "utf-8");

    expect(layout).toContain('\\"hello\\"');
    expect(layout).toContain("\\\\backslash");
  });

  it("correctly escapes backslash followed by newline without collapsing sequences", async () => {
    const runtime = createZellijRuntime({ homePath, runCommand: vi.fn() });
    const launchMixed: AgentLaunchSpec = {
      command: "claude",
      args: ["--", "before\\\nafter"],
      cwd: "/home/matrixos/home/projects/repo",
      env: {},
    };

    const result = await runtime.generateLayout({ sessionId: "sess_esc3", launch: launchMixed });
    const layout = await readFile(result.layoutPath, "utf-8");

    expect(layout).toContain("\\\\\\n");
    expect(layout).not.toContain("\n" + "after");
  });

  it("returns degraded health when zellij is unavailable without exposing raw errors", async () => {
    const runCommand = vi.fn(async () => {
      throw new Error("ENOENT /usr/bin/zellij secret-path");
    });
    const runtime = createZellijRuntime({ homePath, runCommand });

    const health = await runtime.health();

    expect(health).toEqual({
      available: false,
      status: "degraded",
      fallbackReason: "zellij_unavailable",
      version: null,
    });
    expect(JSON.stringify(health)).not.toContain("secret-path");
  });
});
