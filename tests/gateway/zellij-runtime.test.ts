import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZellijRuntime } from "../../packages/gateway/src/zellij-runtime.js";
import type { AgentLaunchSpec } from "../../packages/gateway/src/agent-launcher.js";

describe("zellij-runtime", () => {
  let homePath: string;
  const launch: AgentLaunchSpec = {
    command: "codex",
    args: ["--sandbox", "workspace-write", "fix tests; rm -rf /"],
    cwd: "/home/matrixos/home/projects/repo/worktrees/wt_123",
    env: {},
  };

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-zellij-runtime-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes a generated layout under the Matrix home without shell interpolation", async () => {
    const runtime = createZellijRuntime({ homePath, runCommand: vi.fn() });

    const result = await runtime.generateLayout({ sessionId: "sess_abc123", launch });

    expect(result.layoutPath).toBe(join(homePath, "system", "zellij", "layouts", "sess_abc123.kdl"));
    const layout = await readFile(result.layoutPath, "utf-8");
    expect(layout).toContain('command "codex"');
    expect(layout).toContain('args "--sandbox" "workspace-write" "fix tests; rm -rf /"');
    expect(layout).toContain('cwd "/home/matrixos/home/projects/repo/worktrees/wt_123"');
    expect(layout).not.toContain("sh -c");
  });

  it("starts, attaches, observes, and kills sessions through argv arrays", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "ok\n", stderr: "" }));
    const runtime = createZellijRuntime({ homePath, runCommand });

    const started = await runtime.start({ sessionId: "sess_abc123", launch });
    expect(started).toMatchObject({
      ok: true,
      sessionName: "matrix-sess_abc123",
      status: "running",
    });
    expect(runCommand).toHaveBeenCalledWith(
      "zellij",
      ["--session", "matrix-sess_abc123", "--layout", started.layoutPath],
      expect.any(Object),
    );

    expect(runtime.attachCommand("sess_abc123")).toEqual(["zellij", "attach", "matrix-sess_abc123"]);
    expect(runtime.observeCommand("sess_abc123")).toEqual(["zellij", "attach", "matrix-sess_abc123", "--index", "0"]);

    await expect(runtime.kill("sess_abc123")).resolves.toEqual({ ok: true });
    expect(runCommand).toHaveBeenCalledWith(
      "zellij",
      ["kill-session", "matrix-sess_abc123"],
      expect.any(Object),
    );
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
