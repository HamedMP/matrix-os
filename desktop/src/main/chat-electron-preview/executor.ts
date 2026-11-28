import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  CHAT_ELECTRON_PREVIEW_BASE_LABEL,
  CHAT_ELECTRON_PREVIEW_SOURCE,
  ChatElectronPreviewMarkerSchema,
  type ChatElectronPreviewMarker,
} from "../../shared/chat-electron-preview";
import { capturePreviewScript } from "./executor-capture";

const labelMarkup = (label: string) => `<span className="signin-eyebrow">${label}</span>`;
const maxSourceBytes = 64 * 1024;
const maxPngBytes = 2 * 1024 * 1024;
const localPath = process.env.PATH ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";

export interface ChatElectronPreviewExecution {
  checkout: string;
  electronPath: string;
  baseSha: string;
  sourceSha256: string;
  label: string;
  operation?: ChatElectronPreviewMarker["operation"];
  signal: AbortSignal;
}

function assertLabel(label: string) {
  if (!ChatElectronPreviewMarkerSchema.shape.label.safeParse(label).success) throw new Error("Unsupported preview label");
}

export function verifiedSignInSource(base: Buffer, label: string, sourceSha256: string): Buffer {
  assertLabel(label);
  const original = Buffer.from(labelMarkup(CHAT_ELECTRON_PREVIEW_BASE_LABEL));
  const start = base.indexOf(original);
  if (base.length > maxSourceBytes || start < 0 || base.indexOf(original, start + original.length) !== -1) {
    throw new Error("Unsupported preview source");
  }
  const patched = Buffer.concat([
    base.subarray(0, start), Buffer.from(labelMarkup(label)), base.subarray(start + original.length),
  ]);
  if (createHash("sha256").update(patched).digest("hex") !== sourceSha256) throw new Error("Preview source checksum mismatch");
  return patched;
}

function localEnvironment(home: string, temp: string): NodeJS.ProcessEnv {
  return {
    PATH: localPath,
    HOME: home,
    TMPDIR: temp,
    LANG: "en_US.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    GIT_TERMINAL_PROMPT: "0",
    MATRIX_NO_TELEMETRY: "1",
    npm_config_userconfig: "/dev/null",
  };
}

type CommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeout: number;
  stage: string;
  maxOutput?: number;
};

/** Give each invocation its own process group. Playwright starts Electron in
 * a separate group, so interrupt the driver first to run its child cleanup. */
function runLocal(program: string, args: readonly string[], options: CommandOptions): Promise<Buffer> {
  const { cwd, env, timeout, stage, maxOutput = 4 * 1024 * 1024 } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let outputSize = 0;
    let exceededOutput = false;
    let secondInterrupt: NodeJS.Timeout | undefined;
    let forceStop: NodeJS.Timeout | undefined;
    function signalGroup(kind: NodeJS.Signals) {
      if (child.pid) {
        try { process.kill(-child.pid, kind); }
        catch (error: unknown) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            console.warn("[chat-electron-preview] Could not terminate local command");
          }
        }
      }
    }
    function terminate() {
      if (forceStop) return;
      signalGroup("SIGINT");
      // Playwright's second interrupt force-closes its own child group.
      secondInterrupt = setTimeout(() => signalGroup("SIGINT"), 3_000);
      forceStop = setTimeout(() => signalGroup("SIGKILL"), 6_000);
    }
    function release() {
      signal.removeEventListener("abort", terminate);
      clearTimeout(secondInterrupt);
      clearTimeout(forceStop);
    }
    function receive(chunk: Buffer, collect: boolean) {
      if (exceededOutput) return;
      outputSize += chunk.length;
      if (outputSize > maxOutput) {
        exceededOutput = true;
        terminate();
      } else if (collect) {
        chunks.push(chunk);
      }
    }
    child.stdout.on("data", (chunk: Buffer) => receive(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => receive(chunk, false));
    const fail = () => new Error(`Electron preview ${stage} failed`);
    child.once("error", () => {
      release();
      reject(fail());
    });
    child.once("close", code => {
      release();
      if (signal.aborted || exceededOutput || code !== 0) reject(fail());
      else resolve(Buffer.concat(chunks));
    });
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
  });
}

function git(args: readonly string[], cwd: string, signal: AbortSignal, timeout = 45_000) {
  return runLocal("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd, signal, timeout, stage: "source checkout",
    env: localEnvironment(homedir(), tmpdir()),
  });
}

async function readBoundedFile(path: string, maximum: number, description: string) {
  // Callers own the directory. Checking the full resolved path also rejects
  // a committed symlink in any ancestor, before the staged source is read.
  const info = await lstat(path);
  if (!info.isFile() || info.size < 1 || info.size > maximum || await realpath(path) !== path) {
    throw new Error(`Invalid ${description}`);
  }
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new Error(`Invalid ${description}`);
  return bytes;
}

function summarizeVitest(output: Buffer): string {
  const matches = [...output.toString("utf8").matchAll(/^\s*Tests\s+(\d{1,4}) passed \((\d{1,4})\)\s*$/gm)];
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match || Number(match[1]) === 0 || match[1] !== match[2]) {
    throw new Error("Electron preview tests did not report a passing count");
  }
  return `Electron Desktop device authorization sign-in: ${match[1]} tests passed.`;
}

async function testAndBuild(source: string, temp: string, signal: AbortSignal) {
  const env = localEnvironment(homedir(), temp);
  const options = { env, signal, cwd: source, timeout: 180_000 };
  // Resolve the installed dependencies at this exact revision from the local
  // content-addressed cache. Offline installs skip all install lifecycle code.
  await runLocal("corepack", [
    "pnpm", "install", "--offline", "--ignore-scripts", "--frozen-lockfile",
    "--config.enable-global-virtual-store=false",
  ], { ...options, stage: "offline dependency preparation" });
  const tests = await runLocal("node", [
    "node_modules/vitest/vitest.mjs", "run", "--reporter=dot", "tests/desktop/signin-device-auth.test.tsx",
  ], { ...options, timeout: 45_000, stage: "focused sign-in tests" });
  const testSummary = summarizeVitest(tests);
  await runLocal("corepack", [
    "pnpm", "--filter", "@matrix-os/brand", "build",
  ], { ...options, timeout: 90_000, stage: "brand build" });
  await runLocal("node", [
    "node_modules/electron-vite/bin/electron-vite.js", "build",
  ], { ...options, cwd: join(source, "desktop"), stage: "Electron build" });
  return testSummary;
}

async function capturePreview(
  source: string,
  root: string,
  { electronPath, label, operation, signal }: ChatElectronPreviewExecution,
): Promise<Buffer> {
  const profile = join(root, "profile");
  const isolatedHome = join(root, "home");
  await Promise.all([
    mkdir(profile, { mode: 0o700 }),
    mkdir(join(isolatedHome, "Library", "Application Support"), { recursive: true, mode: 0o700 }),
  ]);
  const destination = join(root, "preview.png");
  await runLocal("node", [
    "--input-type=module", "--eval", capturePreviewScript, electronPath, profile, destination, label, operation ?? "",
  ], { cwd: source, stage: "capture", timeout: 95_000, signal, env: localEnvironment(isolatedHome, root) });
  const png = await readBoundedFile(destination, maxPngBytes, "preview screenshot");
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid preview screenshot");
  return png;
}

export async function runChatElectronPreview(request: ChatElectronPreviewExecution): Promise<{ png: Buffer; testSummary: string }> {
  const { baseSha, sourceSha256, label, operation, electronPath, signal } = request;
  signal.throwIfAborted();
  assertLabel(label);
  if (!ChatElectronPreviewMarkerSchema.shape.operation.safeParse(operation).success) {
    throw new Error("Unsupported Electron preview interaction");
  }
  if (!ChatElectronPreviewMarkerSchema.shape.baseSha.safeParse(baseSha).success || !isAbsolute(request.checkout) || !isAbsolute(electronPath)) {
    throw new Error("Invalid local preview configuration");
  }
  const checkout = await realpath(request.checkout);
  const [head, top] = await Promise.all([
    git(["rev-parse", "--verify", "HEAD^{commit}"], checkout, signal),
    git(["rev-parse", "--show-toplevel"], checkout, signal),
  ]);
  if (head.toString().trimEnd() !== baseSha || top.toString().trimEnd() !== checkout) {
    throw new Error("Electron preview requires the trusted local revision");
  }

  const root = await mkdtemp(join(await realpath(tmpdir()), "matrix-chat-preview-"));
  const worktree = join(root, "source");
  try {
    await git(["worktree", "add", "--detach", "--", worktree, baseSha], checkout, signal);
    const source = join(worktree, CHAT_ELECTRON_PREVIEW_SOURCE);
    const base = await readBoundedFile(source, maxSourceBytes, "preview source");
    const candidate = verifiedSignInSource(base, label, sourceSha256);
    await writeFile(source, candidate);
    const testSummary = await testAndBuild(worktree, root, signal);
    // The trusted build may generate ignored outputs. Recheck the bound input
    // after the build as well, before sending anything to the Chat.
    if (!(await readBoundedFile(source, maxSourceBytes, "preview source")).equals(candidate)) {
      throw new Error("Preview source changed during build");
    }
    const png = await capturePreview(worktree, root, request);
    return {
      png,
      testSummary: operation === "verify-sign-in-recovery"
        ? `${testSummary} Sign in showed a recoverable connection error and re-enabled retry.`
        : testSummary,
    };
  } finally {
    try {
      const marker = await lstat(join(worktree, ".git")).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      // Removing the offline dependency tree can take longer than a Git read.
      // The cleanup deadline is independent of the canceled request.
      if (marker) await git(["worktree", "remove", "--force", "--", worktree], checkout, new AbortController().signal, 180_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
