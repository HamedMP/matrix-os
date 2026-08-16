#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { spawn } from "node-pty";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT_MS = 10_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const INITIAL_SIZE = { cols: 160, rows: 60 };
const RESIZED_SIZE = { cols: 132, rows: 44 };

const zellijBinary = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: smoke-zellij-watcher-sizing.mjs <path-to-staged-zellij>");
  process.exit(2);
}
await access(zellijBinary);

const { stdout: versionOutput } = await execFileAsync(zellijBinary, ["--version"], {
  timeout: 2_000,
});
const version = versionOutput.trim().replace(/^zellij\s+/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`unexpected Zellij version output: ${versionOutput.trim()}`);
}

const testRoot = await mkdtemp(join(tmpdir(), "mzw-"));
const homeDir = join(testRoot, "home");
const configDir = join(testRoot, "config", "zellij");
const cacheDir = join(testRoot, "cache");
const dataDir = join(testRoot, "data");
const runtimeDir = join(testRoot, "runtime");
const tempDir = join(testRoot, "tmp");
const configPath = join(configDir, "config.kdl");
const layoutPath = join(testRoot, "layout.kdl");
const probePath = join(testRoot, "pane-size-probe.mjs");
const resultPath = join(testRoot, "pane-size.json");
const sessionName = `mzw-${randomUUID().slice(0, 8)}`;
const socketDir = join("/tmp", `${sessionName}-sockets`);

await Promise.all([
  mkdir(homeDir, { recursive: true }),
  mkdir(configDir, { recursive: true }),
  mkdir(cacheDir, { recursive: true }),
  mkdir(dataDir, { recursive: true }),
  mkdir(runtimeDir, { recursive: true }),
  mkdir(tempDir, { recursive: true }),
  mkdir(join(cacheDir, "zellij", version), { recursive: true }),
]);
await writeFile(join(cacheDir, "zellij", version, "seen_release_notes"), "");
await writeFile(configPath, [
  "pane_frames false",
  "simplified_ui true",
  "show_startup_tips false",
  "session_serialization false",
  "disable_session_metadata true",
  "copy_on_select false",
  "",
].join("\n"));
await writeFile(probePath, `
import { writeFileSync } from "node:fs";

const resultPath = process.argv[2];
function recordSize() {
  writeFileSync(resultPath, JSON.stringify({
    cols: process.stdout.columns,
    rows: process.stdout.rows,
  }));
}
process.on("SIGWINCH", recordSize);
setInterval(recordSize, 50);
recordSize();
`);
await writeFile(layoutPath, `layout {
  pane command="${process.execPath}" {
    args "${probePath}" "${resultPath}"
  }
}
`);

const isolatedEnv = {
  COLORTERM: "truecolor",
  HOME: homeDir,
  LANG: "C.UTF-8",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  SHELL: "/bin/sh",
  TERM: "xterm-256color",
  TMPDIR: tempDir,
  XDG_CACHE_HOME: cacheDir,
  XDG_CONFIG_HOME: join(testRoot, "config"),
  XDG_DATA_HOME: dataDir,
  XDG_RUNTIME_DIR: runtimeDir,
  ZELLIJ_SOCKET_DIR: socketDir,
  ZELLIJ_CONFIG_DIR: configDir,
  ZELLIJ_CONFIG_FILE: configPath,
};

function answerHostQueries(terminal) {
  let answered = false;
  let capture = "";
  return terminal.onData((data) => {
    capture = (capture + data).slice(-MAX_CAPTURE_BYTES);
    if (answered || !capture.includes("\x1b]4;255;?\x1b\\")) return;
    answered = true;
    const paletteReplies = Array.from({ length: 256 }, (_, index) => (
      `\x1b]4;${index};rgb:ffff/0000/ffff\x1b\\`
    )).join("");
    terminal.write([
      "\x1b[4;960;1440t",
      "\x1b[6;24;12t",
      "\x1b]11;rgb:0000/0000/0000\x1b\\",
      "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
      paletteReplies,
    ].join(""));
  });
}

async function waitForSize(expected) {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  let observed = null;
  while (Date.now() < deadline) {
    try {
      observed = JSON.parse(await readFile(resultPath, "utf8"));
      if (observed.cols === expected.cols && observed.rows === expected.rows) return;
    } catch (error) {
      const retryable = error instanceof SyntaxError
        || (error instanceof Error && "code" in error && error.code === "ENOENT");
      if (!retryable) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(
    `pane size did not reach ${expected.cols}x${expected.rows}; observed ${JSON.stringify(observed)}`,
  );
}

async function sessionExists() {
  try {
    const { stdout } = await execFileAsync(zellijBinary, ["list-sessions", "--short"], {
      cwd: homeDir,
      env: isolatedEnv,
      timeout: 1_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.split("\n").includes(sessionName);
  } catch (error) {
    const diagnostic = error && typeof error === "object"
      ? `${"stdout" in error ? error.stdout : ""} ${"stderr" in error ? error.stderr : ""}`
      : String(error);
    if (/No active (?:zellij )?sessions|failed to receive message/i.test(diagnostic)) return false;
    throw error;
  }
}

async function startDetachedSession() {
  const starter = spawn(zellijBinary, [
    "--new-session-with-layout", layoutPath,
    "attach", "--create-background", sessionName,
  ], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: homeDir,
    env: isolatedEnv,
  });
  const hostReplies = answerHostQueries(starter);
  let exit;
  starter.onExit((event) => {
    exit = event;
  });
  const deadline = Date.now() + 5_000;
  let created = false;
  while (Date.now() < deadline) {
    if (await sessionExists()) {
      created = true;
      break;
    }
    if (exit) {
      hostReplies.dispose();
      throw new Error(`detached Zellij startup exited with ${exit.signal ?? exit.exitCode}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (created) {
    const exitDeadline = Date.now() + 2_000;
    while (!exit && Date.now() < exitDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    hostReplies.dispose();
    if (!exit) {
      starter.kill();
      throw new Error("detached Zellij startup did not exit");
    }
    if (exit.exitCode !== 0) {
      throw new Error(`detached Zellij startup exited with ${exit.signal ?? exit.exitCode}`);
    }
    return;
  }
  hostReplies.dispose();
  starter.kill();
  throw new Error("detached Zellij startup timed out");
}

async function assertTerminalStaysAlive(terminal, label) {
  let exit;
  const exitListener = terminal.onExit((event) => {
    exit = event;
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  exitListener.dispose();
  if (exit) throw new Error(`${label} exited with ${exit.signal ?? exit.exitCode}`);
}

let watcher;
let interactive;
let watcherHostReplies;
let interactiveHostReplies;
try {
  await startDetachedSession();

  interactive = spawn(zellijBinary, ["attach", sessionName], {
    name: "xterm-256color",
    ...INITIAL_SIZE,
    cwd: homeDir,
    env: isolatedEnv,
  });
  interactiveHostReplies = answerHostQueries(interactive);
  await waitForSize(INITIAL_SIZE);

  watcher = spawn(zellijBinary, ["watch", sessionName], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: homeDir,
    env: isolatedEnv,
  });
  watcherHostReplies = answerHostQueries(watcher);
  await assertTerminalStaysAlive(watcher, "watcher");

  await waitForSize(INITIAL_SIZE);
  interactive.resize(RESIZED_SIZE.cols, RESIZED_SIZE.rows);
  await waitForSize(RESIZED_SIZE);

  console.log(`Zellij watcher sizing smoke test passed for ${zellijBinary}`);
} finally {
  watcherHostReplies?.dispose();
  interactiveHostReplies?.dispose();
  watcher?.kill();
  interactive?.kill();
  try {
    await execFileAsync(zellijBinary, ["kill-session", sessionName], {
      cwd: homeDir,
      env: isolatedEnv,
      timeout: 2_000,
    });
  } catch (error) {
    const diagnostic = error && typeof error === "object"
      ? `${"message" in error ? error.message : ""} ${"stdout" in error ? error.stdout : ""} ${"stderr" in error ? error.stderr : ""}`
      : String(error);
    if (!/does not exist|failed to receive message|No active (?:zellij )?sessions|No session named/i.test(diagnostic)) {
      throw error;
    }
  }
  await Promise.all([
    rm(testRoot, { recursive: true, force: true }),
    rm(socketDir, { recursive: true, force: true }),
  ]);
}
