import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { MAC_VERIFICATION_SOURCE_BY_RECIPE, type MacVerificationRecipe } from "@matrix-os/contracts/mac-verification-terminal";
import { dirname, isAbsolute, join } from "node:path";
import { checkVerificationStore, clearVerificationStoreProjects, type VerificationToolchain } from "./source-provider";
import {
  CHAT_ELECTRON_PREVIEW_SOURCE,
  ChatElectronPreviewLabelSchema,
  ChatElectronPreviewMarkerSchema,
  type ChatElectronPreviewMarker,
} from "../../shared/chat-electron-preview";
import { capturePreviewScript } from "./executor-capture";
import { verifiedFilesTrashSource } from "./files-source";
import { MAX_SIGN_IN_SOURCE_BYTES, verifiedSignInSource } from "./source";
import type { ChatElectronPreviewTarget } from "../../shared/chat-electron-preview-ipc";

export { verifiedSignInSource } from "./source";
const maxPngBytes = 2 * 1024 * 1024;
const localPath = [process.env.PATH, "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");

export interface ChatElectronPreviewExecution {
  checkout: string;
  electronPath: string;
  toolchain?: VerificationToolchain;
  baseSha: string;
  sourceSha256: string;
  label: string;
  requestKind?: ChatElectronPreviewTarget["requestKind"];
  recipe?: MacVerificationRecipe;
  operation?: ChatElectronPreviewMarker["operation"];
  signal: AbortSignal;
}

function localEnvironment(home: string, temp: string, toolchain?: VerificationToolchain): NodeJS.ProcessEnv {
  return {
    PATH: toolchain ? `${dirname(toolchain.node)}:/usr/bin:/bin` : localPath,
    HOME: home,
    TMPDIR: temp,
    LANG: "en_US.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    MATRIX_NO_TELEMETRY: "1",
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null",
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

const MAX_STDERR_DIAGNOSTIC_BYTES = 8192;

function diagnosticStderr(bytes: Buffer) {
  const sanitized = stripVTControlCharacters(bytes.toString("utf8"))
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)(["']?\s*[:=]\s*["']?)[^"'\s&,;]+/gi, "$1$2[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  const encoded = Buffer.from(sanitized);
  let tail = encoded.subarray(Math.max(0, encoded.length - MAX_STDERR_DIAGNOSTIC_BYTES)).toString("utf8");
  while (Buffer.byteLength(tail) > MAX_STDERR_DIAGNOSTIC_BYTES) tail = tail.slice(1);
  return tail;
}

function localFailure(stage: string, stderr: Buffer, outcome: {
  exitCode: number | null; terminationSignal: NodeJS.Signals | null; timedOut: boolean; outputExceeded: boolean;
  spawnErrorCode: string | null;
}) {
  const diagnostic = { stage, ...outcome, stderrTail: diagnosticStderr(stderr), logWriteError: undefined as string | undefined };
  // Native operator diagnostics only. The renderer/Chat receives the fixed
  // error message and service-owned failure enum, never this output. A broken
  // parent stdio pipe must not crash the Electron main process (EPIPE).
  try { writeSync(2, `[mac-verification] local stage failed ${JSON.stringify(diagnostic)}\n`); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && (error.code === "EPIPE" || error.code === "EBADF"))) {
      diagnostic.logWriteError = error instanceof Error ? error.name : "UnknownError";
    }
  }
  return new Error(`Electron preview ${stage} failed`, { cause: diagnostic });
}

/** Give each invocation its own process group. Playwright starts Electron in
 * a separate group, so interrupt the driver first to run its child cleanup. */
function runLocal(program: string, args: readonly string[], options: CommandOptions): Promise<Buffer> {
  const { cwd, env, timeout, stage, maxOutput = 4 * 1024 * 1024 } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderrTail = Buffer.alloc(0);
    let failureReported = false;
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
      if (!collect) {
        stderrTail = Buffer.concat([stderrTail, chunk.subarray(-MAX_STDERR_DIAGNOSTIC_BYTES)])
          .subarray(-MAX_STDERR_DIAGNOSTIC_BYTES);
      }
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
    const fail = (exitCode: number | null, terminationSignal: NodeJS.Signals | null, spawnErrorCode: string | null = null) => {
      failureReported = true;
      return localFailure(stage, stderrTail, { exitCode, terminationSignal, spawnErrorCode,
        timedOut: signal.aborted && signal.reason?.name === "TimeoutError", outputExceeded: exceededOutput });
    };
    child.once("error", error => {
      release();
      const code = "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : null;
      reject(fail(null, null, code));
    });
    child.once("close", (code, terminationSignal) => {
      release();
      if (failureReported) return;
      if (signal.aborted || exceededOutput || code !== 0) reject(fail(code, terminationSignal));
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

function summarizeVitest(output: Buffer, suite: string): string {
  const matches = [...output.toString("utf8").matchAll(/^\s*Tests\s+(\d{1,4}) passed \((\d{1,4})\)\s*$/gm)];
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match || Number(match[1]) === 0 || match[1] !== match[2]) {
    throw new Error("Electron preview tests did not report a passing count");
  }
  return `${suite}: ${match[1]} tests passed.`;
}

async function testAndBuild(source: string, temp: string, signal: AbortSignal, recipe: MacVerificationRecipe | undefined, toolchain?: VerificationToolchain) {
  const home = toolchain ? join(temp, "build-home") : homedir();
  if (toolchain) await mkdir(home, { mode: 0o700 });
  const env = localEnvironment(home, temp, toolchain);
  const options = { env, signal, cwd: source, timeout: 180_000 };
  const node = toolchain?.node ?? "node";
  const pnpm = toolchain ? { program: node, prefix: [toolchain.pnpm] } : { program: "corepack", prefix: ["pnpm"] };
  // The signed source lockfile fixes the dependency graph. Install into an
  // owned cache after consent, excluding unrelated mobile importers and hooks.
  const budget = new AbortController();
  const installSignal = AbortSignal.any([signal, budget.signal]);
  let monitor: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<void> | undefined;
  function watchStore() {
    monitor = setTimeout(() => {
      checking = checkVerificationStore(toolchain!.store, installSignal, true)
        .catch((error: unknown) => { budget.abort(error); })
        .finally(() => { if (!installSignal.aborted) watchStore(); });
    }, 5_000);
    monitor.unref();
  }
  try {
    if (toolchain) {
      await clearVerificationStoreProjects(toolchain.store);
      await checkVerificationStore(toolchain.store, installSignal);
      watchStore();
    }
    await runLocal(pnpm.program, [
      ...pnpm.prefix, "--filter", ".", "--filter", "desktop...", "--filter", "@matrix-os/gateway...", "--filter", "shell...",
      "install", "--ignore-scripts", "--ignore-pnpmfile", "--frozen-lockfile",
      "--config.enable-global-virtual-store=false", "--config.registry=https://registry.npmjs.org/",
      "--config.strict-ssl=true", "--config.verify-store-integrity=true", "--config.package-import-method=copy",
      ...(toolchain ? ["--store-dir", toolchain.store] : []),
    ], { ...options, signal: installSignal, timeout: 600_000, stage: "dependency preparation" });
  } finally {
    clearTimeout(monitor); budget.abort(); await checking;
    if (toolchain) {
      // pnpm records the active checkout here. It is administrative metadata,
      // not dependency bytes, and must not retain a deleted request path.
      await clearVerificationStoreProjects(toolchain.store);
    }
  }
  if (toolchain) await checkVerificationStore(toolchain.store, signal);
  const filesTrash = recipe === "files-trash";
  const tests = await runLocal(node, [
    "node_modules/vitest/vitest.mjs", "run", "--reporter=dot",
    filesTrash ? "tests/gateway/trash.test.ts" : "tests/desktop/signin-device-auth.test.tsx",
  ], { ...options, timeout: 45_000, stage: filesTrash ? "focused Trash tests" : "focused sign-in tests" });
  const testSummary = summarizeVitest(tests, filesTrash ? "Gateway Trash" : "Electron Desktop device authorization sign-in");
  await runLocal(pnpm.program, [
    ...pnpm.prefix, "--filter", "@matrix-os/brand", "build",
  ], { ...options, timeout: 90_000, stage: "brand build" });
  await runLocal(node, [
    "node_modules/electron-vite/bin/electron-vite.js", "build",
  ], { ...options, cwd: join(source, "desktop"), stage: "Electron build" });
  return testSummary;
}

async function capturePreview(
  source: string,
  root: string,
  { electronPath, label, operation, recipe, signal, toolchain }: ChatElectronPreviewExecution,
): Promise<Buffer> {
  const profile = join(root, "profile");
  const isolatedHome = join(root, "home");
  await Promise.all([
    mkdir(profile, { mode: 0o700 }),
    mkdir(join(isolatedHome, "Library", "Application Support"), { recursive: true, mode: 0o700 }),
  ]);
  const destination = join(root, "preview.png");
  const args = recipe === "files-trash"
    ? ["--import", "tsx", "tests/e2e/desktop/fixtures/mac-verification-files.mts", electronPath, profile, destination, label]
    : ["--input-type=module", "--eval", capturePreviewScript, electronPath, profile, destination, label, operation ?? ""];
  await runLocal(toolchain?.node ?? "node", args, { cwd: source, stage: "capture", timeout: 95_000, signal, env: localEnvironment(isolatedHome, root, toolchain) });
  const png = await readBoundedFile(destination, maxPngBytes, "preview screenshot");
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid preview screenshot");
  return png;
}

export async function runChatElectronPreview(request: ChatElectronPreviewExecution): Promise<{ png: Buffer; testSummary: string }> {
  const { baseSha, sourceSha256, label, operation, recipe, electronPath, signal, toolchain } = request;
  signal.throwIfAborted();
  const verification = request.requestKind === "verification";
  const filesTrash = recipe === "files-trash";
  if (filesTrash ? (!verification || operation !== undefined)
    : !(verification ? ChatElectronPreviewLabelSchema : ChatElectronPreviewMarkerSchema.shape.label).safeParse(label).success) {
    throw new Error("Unsupported preview label");
  }
  if (!ChatElectronPreviewMarkerSchema.shape.operation.safeParse(operation).success) {
    throw new Error("Unsupported Electron preview interaction");
  }
  if (!ChatElectronPreviewMarkerSchema.shape.baseSha.safeParse(baseSha).success || !isAbsolute(request.checkout) || !isAbsolute(electronPath)) {
    throw new Error("Invalid local preview configuration");
  }
  if (toolchain && !Object.values(toolchain).every(isAbsolute)) throw new Error("Invalid private preview toolchain");
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
    const source = join(worktree, recipe ? MAC_VERIFICATION_SOURCE_BY_RECIPE[recipe] : CHAT_ELECTRON_PREVIEW_SOURCE);
    const base = await readBoundedFile(source, MAX_SIGN_IN_SOURCE_BYTES, "preview source");
    const candidate = filesTrash ? verifiedFilesTrashSource(base, label, sourceSha256)
      : verifiedSignInSource(base, label, sourceSha256, verification);
    await writeFile(source, candidate);
    const testSummary = await testAndBuild(worktree, root, signal, recipe, toolchain);
    // The trusted build may generate ignored outputs. Recheck the bound input
    // after the build as well, before sending anything to the Chat.
    if (!(await readBoundedFile(source, MAX_SIGN_IN_SOURCE_BYTES, "preview source")).equals(candidate)) {
      throw new Error("Preview source changed during build");
    }
    const png = await capturePreview(worktree, root, request);
    return {
      png,
      testSummary: operation === "verify-sign-in-recovery"
        ? `${testSummary} Sign in showed a recoverable connection error and re-enabled retry.`
        : filesTrash ? `${testSummary} Electron Desktop Files moved the target to Trash and restored it with Undo.` : testSummary,
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
