#!/usr/bin/env -S node --import tsx
// Exercise real Matrix attachments against servers retaining older configuration.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createZellijAdapter, type ShellAttachProcess } from "../packages/gateway/src/shell/zellij.js";
import { createZellijRuntime } from "../packages/gateway/src/zellij-runtime.js";

const run = promisify(execFile);
const binary = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: smoke-zellij-session-config.ts <zellij-binary>");
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const spawnPty = createRequire(import.meta.url)("node-pty").spawn;

function fixtureEnv(root: string) {
  return {
    HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color", LANG: "C.UTF-8",
    XDG_RUNTIME_DIR: join(root, "runtime"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), TMPDIR: join(root, "tmp"),
    ZELLIJ_CONFIG_DIR: root, ZELLIJ_CONFIG_FILE: join(root, "client.kdl"), ZELLIJ_SOCKET_DIR: join(root, "s"),
  };
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(label);
}

// The supervisor owns all fixture roots and daemons. Killing a timed-out worker
// cannot bypass cleanup, unlike an outer `timeout --signal=KILL` on this script.
async function supervise() {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "mzc-"));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  let failure: unknown;
  try {
    const result = await run(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), binary, root], {
      timeout: 35_000, killSignal: "SIGKILL", signal: controller.signal, maxBuffer: 512 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    failure = error;
  } finally {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("case-")) continue;
        const fixture = join(root, entry.name);
        try {
          const session = await readFile(join(fixture, "session"), "utf8");
          if (!/^matrix-sess_[0-9a-f]{8}$/.test(session)) throw new Error("invalid smoke session marker");
          await run(binary, ["kill-session", session], { env: fixtureEnv(fixture), timeout: 5_000 });
        } catch (error) {
          console.error("Zellij smoke cleanup failed:", error);
          failure ??= error;
        }
      }
    } finally {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        console.error("Zellij smoke directory cleanup failed:", error);
        failure ??= error;
      }
      process.removeListener("SIGTERM", abort);
      process.removeListener("SIGINT", abort);
    }
  }
  if (failure) throw failure;
}

async function exercise(parentRoot: string) {
  for (const savedMode of ["normal", "locked"]) {
    const root = await mkdtemp(join(parentRoot, "case-"));
    const env = fixtureEnv(root);
    const serverConfig = join(root, "server.kdl");
    const inputPath = join(root, "input");
    const pidPath = join(root, "pane-pid");
    const probe = join(root, "probe.mjs");
    const layout = join(root, "layout.kdl");
    const sessionId = `sess_${randomUUID().slice(0, 8)}`;
    const session = `matrix-${sessionId}`;
    let client: ShellAttachProcess | undefined;
    try {
      // Record before launch so the supervisor can recover even a timed-out start.
      await writeFile(join(root, "session"), session);
      await Promise.all([env.XDG_RUNTIME_DIR, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.TMPDIR]
        .map((path) => mkdir(path, { recursive: true })));
      const common = "pane_frames false\nshow_startup_tips false\nshow_release_notes false\nsession_serialization false\n";
      await writeFile(serverConfig, `${common}default_mode "${savedMode}"\n`);
      await writeFile(env.ZELLIJ_CONFIG_FILE, `${common}default_mode "locked"\n`);
      await writeFile(inputPath, "");
      await writeFile(probe, `
import { appendFile, writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(pidPath)}, String(process.pid));
process.stdin.setRawMode(true);
let bytes = 0;
let writes = Promise.resolve();
process.stdin.on('data', data => {
  bytes += data.length;
  if (bytes > 4096) process.exit(2);
  writes = writes.then(() => appendFile(${JSON.stringify(inputPath)}, data));
});
process.stdout.write('READY');
setTimeout(() => process.exit(0), 30000);
`);
      await writeFile(layout, `layout {
  pane command=${JSON.stringify(process.execPath)} {
    args ${JSON.stringify(probe)}
  }
}
`);
      await run(binary, ["--config", serverConfig, "--layout", layout, "attach", "--create-background", session], {
        env, cwd: root, timeout: 5_000,
      });
      await waitFor(async () => readFile(pidPath).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }), "pane did not start");
      const originalPid = await readFile(pidPath, "utf8");
      const adapter = createZellijAdapter({ binaryPath: binary, cwd: root, env, manageConfig: false });
      const runtime = createZellijRuntime({ homePath: root });
      let expected = "";
      for (const path of ["direct", "reconnect", "indexed"]) {
        client = path === "indexed"
          ? spawnPty(binary, runtime.observeCommand(sessionId).slice(1), {
              name: "xterm-256color", cols: 80, rows: 24, cwd: root, env,
            })
          : adapter.attachSession(session, { size: { cols: 80, rows: 24 } });
        let output = "";
        const data = client!.onData((chunk) => { output = (output + chunk).slice(-65_536); });
        await waitFor(async () => output.includes("READY"), `${savedMode}/${path} did not render the live pane`);
        // Ctrl+p must reach new Locked sessions, not enter native pane mode.
        const inputs = ["q", "\x7f", "\x1b[200~paste\x1b[201~", ...(savedMode === "locked" ? ["\x10"] : [])];
        for (const input of inputs) {
          // The probe never enables bracketed paste; Zellij strips its markers.
          expected += input.startsWith("\x1b[200~") ? "paste" : input;
          client!.write(input);
          await waitFor(async () => (await readFile(inputPath, "utf8")) === expected,
            `${savedMode}/${path} lost input: ${JSON.stringify(input)}`);
        }
        client!.kill();
        client = undefined;
        data.dispose();
        await delay(150);
        if (await readFile(pidPath, "utf8") !== originalPid) throw new Error("pane process was replaced");
      }
      console.log(`PASS: ${savedMode} server, direct/reconnect/indexed, typing/paste/Ctrl keys, same process`);
    } finally {
      client?.kill();
      // Daemon and directory cleanup belongs to the supervisor, even on timeout.
    }
  }
}

if (process.argv[3]) await exercise(process.argv[3]);
else await supervise();
