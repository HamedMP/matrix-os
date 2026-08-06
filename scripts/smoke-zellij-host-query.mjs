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
const OLD_HOST_QUERY_TIMEOUT_MS = 500;
const HOST_REPLY_DELAY_MS = OLD_HOST_QUERY_TIMEOUT_MS + 250;
const SENTINEL = `matrix-zellij-input-${randomUUID()}`;
const MAX_CAPTURE_BYTES = 1024 * 1024;

const zellijBinary = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: smoke-zellij-host-query.mjs <path-to-staged-zellij>");
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

const testRoot = await mkdtemp(join(tmpdir(), "mzq-"));
const homeDir = join(testRoot, "home");
const configDir = join(testRoot, "config", "zellij");
const cacheDir = join(testRoot, "cache");
const dataDir = join(testRoot, "data");
const runtimeDir = join(testRoot, "runtime");
const tempDir = join(testRoot, "tmp");
const configPath = join(configDir, "config.kdl");
const layoutPath = join(testRoot, "layout.kdl");
const probePath = join(testRoot, "pane-probe.mjs");
const resultPath = join(testRoot, "pane-input.json");
const sessionName = `mhq-${randomUUID().slice(0, 8)}`;
try {
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
import { writeFile } from "node:fs/promises";

const resultPath = process.argv[2];
const sentinel = process.argv[3];
const chunks = [];
let totalBytes = 0;
let overflow = false;
let finished = false;
const maxInputBytes = 64 * 1024;

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

async function finish() {
  if (finished) return;
  finished = true;
  const input = Buffer.concat(chunks, totalBytes);
  await writeFile(resultPath, JSON.stringify({
    inputBase64: input.toString("base64"),
    overflow,
  }));
  process.exit(0);
}

process.stdin.on("data", (chunk) => {
  const bytes = Buffer.from(chunk);
  if (totalBytes + bytes.length > maxInputBytes) {
    overflow = true;
    void finish();
    return;
  }
  chunks.push(bytes);
  totalBytes += bytes.length;
  if (Buffer.concat(chunks, totalBytes).includes(Buffer.from(sentinel))) {
    setTimeout(() => void finish(), 400);
  }
});

setTimeout(() => void finish(), 7_000);
`);

  await writeFile(layoutPath, `layout {
  pane command="${process.execPath}" {
    args "${probePath}" "${resultPath}" "${SENTINEL}"
  }
}
`);
} catch (error) {
  await rm(testRoot, { recursive: true, force: true });
  throw error;
}

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
  ZELLIJ_CONFIG_DIR: configDir,
  ZELLIJ_CONFIG_FILE: configPath,
};

let terminal;
let capturedOutput = "";
let startupRepliesSent = false;
let delayedReplyScheduled = false;
let sentinelSent = false;
let replyTimer;
let sentinelTimer;
let timeoutTimer;

try {
  terminal = spawn(
    zellijBinary,
    ["--session", sessionName, "--new-session-with-layout", layoutPath],
    {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: homeDir,
      env: isolatedEnv,
    },
  );

  await new Promise((resolveTest, rejectTest) => {
    timeoutTimer = setTimeout(() => {
      const diagnostic = capturedOutput.replaceAll("\x1b", "<ESC>").slice(-2_000);
      rejectTest(new Error(
        `Zellij host-query smoke test exceeded ${TEST_TIMEOUT_MS}ms: ${diagnostic}`,
      ));
    }, TEST_TIMEOUT_MS);

    terminal.onData((data) => {
      capturedOutput = (capturedOutput + data).slice(-MAX_CAPTURE_BYTES);

      if (!startupRepliesSent && capturedOutput.includes("\x1b]4;255;?\x1b\\")) {
        startupRepliesSent = true;
        const paletteReplies = Array.from(
          { length: 255 },
          (_, index) => index < 42 ? index : index + 1,
        ).map(
          (index) => `\x1b]4;${index};rgb:ffff/0000/ffff\x1b\\`,
        ).join("");
        terminal.write([
          "\x1b[4;960;1440t",
          "\x1b[6;24;12t",
          "\x1b]11;rgb:0000/0000/0000\x1b\\",
          "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
          paletteReplies,
        ].join(""));
        delayedReplyScheduled = true;
        replyTimer = setTimeout(() => {
          terminal.write("\x1b]4;42;rgb:ffff/0000/ffff\x1b\\");
          sentinelTimer = setTimeout(() => {
            sentinelSent = true;
            terminal.write(`${SENTINEL}\r`);
          }, 500);
        }, HOST_REPLY_DELAY_MS);
      }

      if (capturedOutput.includes(SENTINEL)) {
        rejectTest(new Error("pane input sentinel was echoed before the probe consumed it"));
      }
    });

    terminal.onExit(({ exitCode }) => {
      if (exitCode !== 0) {
        const diagnostic = capturedOutput.replaceAll("\x1b", "<ESC>").slice(-2_000);
        rejectTest(new Error(
          `Zellij exited before the smoke test completed (exit ${exitCode}): ${diagnostic}`,
        ));
      }
    });

    let pollAttempts = 0;
    const maxPollAttempts = Math.ceil(TEST_TIMEOUT_MS / 50);
    const pollResult = async () => {
      try {
        const result = JSON.parse(await readFile(resultPath, "utf8"));
        resolveTest(result);
      } catch (error) {
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
        if (missing || error instanceof SyntaxError) {
          pollAttempts += 1;
          if (pollAttempts >= maxPollAttempts) {
            rejectTest(new Error("pane input probe did not produce a bounded result"));
            return;
          }
          setTimeout(() => void pollResult(), 50);
          return;
        }
        rejectTest(error);
      }
    };
    void pollResult();
  }).then((result) => {
    if (!startupRepliesSent || !delayedReplyScheduled) {
      throw new Error("Zellij did not issue the expected OSC 4 host palette queries");
    }
    if (result.overflow) {
      throw new Error("pane input exceeded the 64 KiB smoke-test limit");
    }
    const paneInput = Buffer.from(result.inputBase64, "base64");
    const inputText = paneInput.toString("utf8");
    if (!inputText.includes(SENTINEL)) {
      throw new Error(
        `pane did not receive ordinary input after the delayed host reply (sent=${sentinelSent}, residual=${paneInput.toString("hex")})`,
      );
    }
    if (inputText.includes("rgb:") || paneInput.includes(Buffer.from("\x1b]4;"))) {
      throw new Error("delayed OSC 4 host reply leaked into the pane's stdin");
    }
  });

  console.log(`Zellij host-query smoke test passed for ${zellijBinary}`);
} finally {
  clearTimeout(replyTimer);
  clearTimeout(sentinelTimer);
  clearTimeout(timeoutTimer);
  if (terminal) terminal.kill();
  try {
    await execFileAsync(zellijBinary, ["kill-session", sessionName], {
      cwd: homeDir,
      env: isolatedEnv,
      timeout: 2_000,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (!error.message.includes("Session not found") && !error.message.includes("No active zellij sessions")) {
      console.error(`Zellij smoke-test cleanup warning: ${error.message}`);
    }
  }
  await rm(testRoot, { recursive: true, force: true });
}
