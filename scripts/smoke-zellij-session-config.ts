#!/usr/bin/env -S node --import tsx
// Exercise the real adapter against a server retaining an earlier configuration.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createZellijAdapter, type ShellAttachProcess } from "../packages/gateway/src/shell/zellij.js";

const run = promisify(execFile);
const binary = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: smoke-zellij-session-config.ts <zellij-binary>");
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(label);
}

for (const savedMode of ["normal", "locked"]) {
  const root = await mkdtemp(join(tmpdir(), "mzc-"));
  const serverConfig = join(root, "server.kdl");
  const clientConfig = join(root, "client.kdl");
  const inputPath = join(root, "input");
  const pidPath = join(root, "pane-pid");
  const probe = join(root, "probe.mjs");
  const layout = join(root, "layout.kdl");
  const session = `mzc-${randomUUID().slice(0, 8)}`;
  const env = {
    HOME: root,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: join(root, "tmp"),
    ZELLIJ_CONFIG_DIR: root,
    ZELLIJ_CONFIG_FILE: clientConfig,
    ZELLIJ_SOCKET_DIR: join(root, "s"),
  };
  let created = false;
  let client: ShellAttachProcess | undefined;
  try {
    await Promise.all([env.XDG_RUNTIME_DIR, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.TMPDIR]
      .map((path) => mkdir(path, { recursive: true })));
    const common = "pane_frames false\nshow_startup_tips false\nshow_release_notes false\nsession_serialization false\n";
    await writeFile(serverConfig, `${common}default_mode "${savedMode}"\n`);
    await writeFile(clientConfig, `${common}default_mode "locked"\n`);
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
    created = true;
    await waitFor(async () => readFile(pidPath).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }), "pane did not start");
    const originalPid = await readFile(pidPath, "utf8");
    const adapter = createZellijAdapter({ binaryPath: binary, cwd: root, env, manageConfig: false });
    let expected = "";
    for (let attachment = 0; attachment < 2; attachment += 1) {
      client = adapter.attachSession(session, { size: { cols: 80, rows: 24 } });
      // Consume output so the attached PTY cannot block on startup queries.
      let output = "";
      const data = client.onData((chunk) => { output = (output + chunk).slice(-65_536); });
      await waitFor(async () => output.includes("READY"), `${savedMode} attachment did not render the live pane`);
      // A new Locked session must still pass Ctrl+p to the application, rather
      // than entering Zellij's native pane mode as a Normal session would.
      const inputs = ["q", "\x7f", "\x1b[200~paste\x1b[201~", ...(savedMode === "locked" ? ["\x10"] : [])];
      for (const input of inputs) {
        // The pane never enables bracketed paste, so Zellij strips its markers.
        expected += input.startsWith("\x1b[200~") ? "paste" : input;
        client.write(input);
        await waitFor(async () => (await readFile(inputPath, "utf8")) === expected,
          `${savedMode} server lost input on attachment ${attachment + 1}: ${JSON.stringify(input)}`);
      }
      client.kill();
      client = undefined;
      data.dispose();
      await delay(150);
      if (await readFile(pidPath, "utf8") !== originalPid) throw new Error("pane process was replaced");
    }
    console.log(`PASS: ${savedMode} server, updated Locked client, typing/paste/reconnect, same pane process`);
  } finally {
    client?.kill();
    if (created) await run(binary, ["kill-session", session], { env, timeout: 5_000 });
    await rm(root, { recursive: true, force: true });
  }
}
