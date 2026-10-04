import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
      expect.objectContaining({ timeout: 10_000, maxBuffer: 4_096, signal }),
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "/opt/matrix/bin/matrix-agent-runtime-control",
      ["switch", "openclaw"],
      expect.objectContaining({ timeout: 330_000, maxBuffer: 4_096, signal }),
    );
    expect(exec).toHaveBeenNthCalledWith(
      3,
      "/opt/matrix/bin/matrix-agent-runtime-control",
      ["stop", "hermes"],
      expect.objectContaining({ timeout: 90_000, maxBuffer: 4_096, signal }),
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

it("reasserts uninstall opt-out after a concurrent installer clears it before lock acquisition", async () => {
  const path = await mkdtemp(join(tmpdir(), "host-uninstall-lock-"));
  cleanupPaths.push(path);
  const home = join(path, "owner");
  await mkdir(join(home, ".local/bin"), {recursive: true});
  await writeFile(join(home, ".local/bin/hermes"), `#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${home}/.hermes/hermes-agent/venv/bin/python" "${home}/.hermes/hermes-agent/hermes" "$@"\n`);
  await mkdir(join(home, ".hermes"));
  await writeFile(join(home, ".hermes/auth.json"), "synthetic owner credentials");
  const source = await readFile("distro/customer-vps/host-bin/matrix-agent-runtime-control", "utf8");
  const functions = source.slice(source.indexOf("stop_install_unit()"), source.indexOf("switch_runtime()"));
  const testScript = join(path, "uninstall.sh");
  await writeFile(testScript, `set -euo pipefail
state_dir=${JSON.stringify(path)}
MATRIX_RUNTIME_HOME=${JSON.stringify(home)}
MATRIX_RUNTIME_USER=fixture
MATRIX_RUNTIME_GROUP=fixture
action_timeout_seconds=5
${functions}
ensure_control_state() { :; }
stop_install_unit() { test -f "$state_dir/disabled-hermes"; }
# Deterministic install/uninstall interleaving: an installer acquired the lock
# first and cleared the early marker; uninstall acquires it only afterward.
acquire_control_lock() { rm -f "$state_dir/disabled-hermes"; }
systemctl() { :; }
timeout() { shift; "$@"; }
setpriv() { shift 5; "$@"; }
uninstall_runtime hermes
`);
  const result = await promisify(execFile)("bash", [testScript], {timeout: 5000});
  expect(JSON.parse(result.stdout)).toMatchObject({ok: true, installed: false});
  await expect(access(join(path, "disabled-hermes"))).resolves.toBeUndefined();
  await expect(access(join(home, ".local/bin/hermes"))).rejects.toMatchObject({code: "ENOENT"});
  expect(await readFile(join(home, ".hermes/auth.json"), "utf8")).toBe("synthetic owner credentials");
});
