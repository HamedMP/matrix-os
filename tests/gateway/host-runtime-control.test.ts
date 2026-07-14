import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostRuntimeControl,
  readOpenClawGatewayToken,
} from "../../packages/gateway/src/agent-config/host-runtime-control.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("fixed host runtime control", () => {
  it("executes only fixed status, switch, and stop arguments with hard limits", async () => {
    const exec = vi.fn(async (_command: string, args: readonly string[]) => ({
      stdout: args[0] === "status"
        ? JSON.stringify({
            ok: true,
            hermes: { installed: true, running: true },
            openclaw: { installed: true, running: false },
          })
        : JSON.stringify({ ok: true, runtime: args[1] }),
      stderr: "",
    }));
    const control = createHostRuntimeControl({ exec });
    const signal = new AbortController().signal;

    await expect(control.status(signal)).resolves.toEqual({
      hermes: { installed: true, running: true },
      openclaw: { installed: true, running: false },
    });
    await control.switch("openclaw", signal);
    await control.stop("hermes", signal);

    expect(exec).toHaveBeenNthCalledWith(
      1,
      "/opt/matrix/bin/matrix-agent-runtime-control",
      ["status"],
      expect.objectContaining({ timeout: 70_000, maxBuffer: 4_096, signal }),
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "/opt/matrix/bin/matrix-agent-runtime-control",
      ["switch", "openclaw"],
      expect.any(Object),
    );
    expect(exec).toHaveBeenNthCalledWith(
      3,
      "/opt/matrix/bin/matrix-agent-runtime-control",
      ["stop", "hermes"],
      expect.any(Object),
    );
  });

  it("maps malformed and failed host responses to provider-neutral errors", async () => {
    const malformed = createHostRuntimeControl({
      exec: vi.fn(async () => ({ stdout: "provider secret detail", stderr: "" })),
    });
    await expect(malformed.status(new AbortController().signal))
      .rejects.toMatchObject({ kind: "invalid_response" });

    const failed = createHostRuntimeControl({
      exec: vi.fn(async () => {
        throw Object.assign(new Error("systemd private path"), {
          stdout: '{"ok":false,"code":"rollback_failed"}',
        });
      }),
    });
    await expect(failed.switch("openclaw", new AbortController().signal))
      .rejects.toMatchObject({ kind: "runtime_switch_failed" });
  });

  it("preserves caller cancellation instead of mapping it to a switch failure", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("shutdown", "AbortError"));
    const exec = vi.fn(async () => {
      throw controller.signal.reason;
    });
    const control = createHostRuntimeControl({ exec });

    await expect(control.status(controller.signal)).rejects.toBe(controller.signal.reason);
  });
});

describe("OpenClaw gateway token loading", () => {
  it("reads only one owner-local 64-hex token assignment", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "openclaw-token-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "system/agent-runtime"), { recursive: true });
    await writeFile(
      join(homePath, "system/agent-runtime/openclaw.env"),
      `OPENCLAW_GATEWAY_TOKEN=${"a".repeat(64)}\n`,
      { mode: 0o600 },
    );

    await expect(readOpenClawGatewayToken(homePath)).resolves.toBe("a".repeat(64));
  });

  it("rejects symlinks, extra lines, and oversized token files", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "openclaw-token-"));
    cleanupPaths.push(homePath);
    const runtimeDir = join(homePath, "system/agent-runtime");
    await mkdir(runtimeDir, { recursive: true });
    const target = join(homePath, "target.env");
    await writeFile(target, `OPENCLAW_GATEWAY_TOKEN=${"b".repeat(64)}\n`);
    const tokenPath = join(runtimeDir, "openclaw.env");
    await symlink(target, tokenPath);
    await expect(readOpenClawGatewayToken(homePath))
      .rejects.toMatchObject({ kind: "runtime_unavailable" });

    await rm(tokenPath);
    await writeFile(tokenPath, `OPENCLAW_GATEWAY_TOKEN=${"b".repeat(64)}\nEXTRA=1\n`);
    await expect(readOpenClawGatewayToken(homePath))
      .rejects.toMatchObject({ kind: "agent_config_invalid" });

    await writeFile(tokenPath, "x".repeat(257));
    await expect(readOpenClawGatewayToken(homePath))
      .rejects.toMatchObject({ kind: "agent_config_invalid" });
  });
});
