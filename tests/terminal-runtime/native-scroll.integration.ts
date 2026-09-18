import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node-pty";
import { expect, it } from "vitest";
import { prepareNativeScrollPlugin, queryNativeScroll } from "../../packages/terminal-runtime/src/native-scroll-bridge.js";

it.runIf(Boolean(process.env.MATRIX_TEST_ZELLIJ_BIN))("keeps native wheel, absolute drag, and appended history in one Zellij buffer", async () => {
  const binary = process.env.MATRIX_TEST_ZELLIJ_BIN!;
  const home = await mkdtemp(join(tmpdir(), "msc-"));
  const socketDir = `/tmp/msc-${randomBytes(8).toString("hex")}`;
  const sessionName = `matrix-rt_${randomBytes(16).toString("hex")}`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TERM: "xterm-256color", ZELLIJ_SOCKET_DIR: socketDir };
  delete env.ZELLIJ; delete env.ZELLIJ_SESSION_NAME; delete env.ZELLIJ_PANE_ID;
  const run = (args: string[], timeoutMs = 5000) => new Promise<string>((resolve, reject) => {
    const child = execFile(binary, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end();
  });
  let pty: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(join(home, ".config/zellij"), { recursive: true });
    await writeFile(join(home, ".config/zellij/config.kdl"), 'pane_frames false\nshow_startup_tips false\nsession_serialization false\n');
    const layout = join(home, "layout.kdl"); await writeFile(layout, 'layout { pane command="sh"; }\n');
    await prepareNativeScrollPlugin(home, {});
    await run(["--config", join(home, ".config/zellij/config.kdl"), "--layout", layout, "attach", "--create-background", sessionName]);
    await run(["--session", sessionName, "action", "new-tab", "--layout", layout]);
    pty = spawn(binary, ["attach", sessionName], { name: "xterm-256color", cols: 120, rows: 36, cwd: home, env });
    pty.onData((data) => { if (data.includes("\x1b[c")) pty?.write("\x1b[?1;2c"); });
    let panes: { is_plugin: boolean; id: number }[] = [];
    await expect.poll(async () => {
      panes = JSON.parse(await run(["--session", sessionName, "action", "list-panes", "--json"]));
      return panes.some((pane) => !pane.is_plugin);
    }).toBe(true);
    const paneId = `terminal_${panes.filter((pane) => !pane.is_plugin).at(-1)!.id}`;
    const command = async (text: string) => {
      await run(["--session", sessionName, "action", "write-chars", "--pane-id", paneId, text]);
      await run(["--session", sessionName, "action", "write", "--pane-id", paneId, "13"]);
    };
    await command("seq 1 200");
    const query = (line?: number) => queryNativeScroll({ sessionName, paneId, line, run });
    // A first pipe can be consumed during plugin load/permission initialization.
    await expect.poll(async () => { try { return (await query()).above; } catch { return 0; } }, { timeout: 10_000 }).toBeGreaterThan(0);
    const bottom = await query(); expect(bottom.below).toBe(0);
    pty.write("\x1b[<64;10;10M".repeat(5));
    await expect.poll(async () => (await query()).below, { timeout: 5000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await query(0)).above).toBe(0);
    await expect.poll(async () => (await query(31)).above).toBe(31);
    await command("sleep 0.2; seq 201 260");
    await expect.poll(async () => (await query(31)).above).toBe(31);
    await expect.poll(async () => { const state = await query(); return state.above + state.below; }).toBeGreaterThan(bottom.above);
    await expect.poll(async () => (await query(100_000)).below).toBe(0);
  } finally {
    await run(["delete-session", sessionName, "--force"]).catch((error: unknown) => console.warn("native-scroll test cleanup", error instanceof Error ? error.message : "unknown"));
    pty?.kill();
    await rm(home, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
  }
}, 30_000);
