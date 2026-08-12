import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { resolveWithinHome } from "../path-security.js";

const execFileAsync = promisify(execFile);
const RuntimeIdSchema = z.string().regex(/^rt_[0-9a-f]{32}$/);
const GenerationSchema = z.string().regex(/^gen_[0-9a-f]{64}$/);
const DisplayNameSchema = z.string().trim().min(1).max(128).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const RuntimeScopeSchema = z.enum(["terminal", "workspace"]);
const DescriptorSchema = z.object({
  version: z.literal(1),
  runtimeId: RuntimeIdSchema,
  sessionName: z.string().regex(/^matrix-rt_[0-9a-f]{32}$/),
  scope: RuntimeScopeSchema,
  kind: z.enum(["shell", "agent"]),
  displayName: DisplayNameSchema,
  cwd: z.string().min(1).max(4096),
  layoutPath: z.string().min(1).max(4096),
  environmentPath: z.string().min(1).max(4096).optional(),
  generation: GenerationSchema,
  createdAt: z.iso.datetime(),
}).strict();

export type UserSystemdTerminalDescriptor = z.infer<typeof DescriptorSchema>;

export interface UserSystemdCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type UserSystemdCommandRunner = (
  command: string,
  args: string[],
  options: UserSystemdCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface CreateUserSystemdRuntimeInput {
  runtimeId: string;
  scope: "terminal" | "workspace";
  kind: "shell" | "agent";
  displayName: string;
  cwd: string;
  layoutPath: string;
  environmentPath?: string;
}

export interface UserSystemdRuntimeResult extends UserSystemdTerminalDescriptor {
  lifecycle: "running";
}

const SYSTEMCTL_TIMEOUT_MS = 10_000;
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_INTERVAL_MS = 100;
const INACTIVE_RECOVERY_RETRY_DELAY_MS = 250;
const MAX_RUNTIME_DESCRIPTORS = 256;
export async function loadInstalledTerminalRuntimeGeneration(appDir = "/opt/matrix/app"): Promise<string> {
  const markerPath = join(resolve(appDir), "TERMINAL_RUNTIME_GENERATION");
  try {
    const stats = await lstat(markerPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 256) {
      throw new TerminalRuntimeUnavailableError();
    }
    const parsed = GenerationSchema.safeParse((await readFile(markerPath, "utf8")).trim());
    if (!parsed.success) throw new TerminalRuntimeUnavailableError();
    return parsed.data;
  } catch (err: unknown) {
    if (err instanceof TerminalRuntimeUnavailableError) throw err;
    throw new TerminalRuntimeUnavailableError(err);
  }
}
class InvalidTerminalRuntimeRequestError extends Error {
  constructor() {
    super("Invalid terminal runtime request");
    this.name = "InvalidTerminalRuntimeRequestError";
  }
}

class TerminalRuntimeUnavailableError extends Error {
  readonly code?: string | number;

  constructor(cause?: unknown) {
    super("Terminal runtime unavailable");
    this.name = "TerminalRuntimeUnavailableError";
    this.code = cause instanceof Error && "code" in cause
      ? (cause as NodeJS.ErrnoException & { code?: string | number }).code
      : undefined;
    this.cause = cause;
  }
}

class TerminalRuntimeIdentityExistsError extends Error {
  constructor() {
    super("Terminal runtime identity already exists");
    this.name = "TerminalRuntimeIdentityExistsError";
  }
}

const defaultRunCommand: UserSystemdCommandRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
};

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error
    && "code" in err
    && (err as NodeJS.ErrnoException).code === code;
}

function pathIsWithin(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function validateOwnedPath(
  homePath: string,
  requestedPath: string,
  expected: "directory" | "file",
): Promise<string> {
  const lexical = resolveWithinHome(homePath, requestedPath);
  if (!lexical) throw new InvalidTerminalRuntimeRequestError();
  try {
    const [homeReal, targetReal, stats] = await Promise.all([
      realpath(homePath),
      realpath(lexical),
      lstat(lexical),
    ]);
    if (!pathIsWithin(homeReal, targetReal) || stats.isSymbolicLink()) {
      throw new InvalidTerminalRuntimeRequestError();
    }
    if (expected === "directory" ? !stats.isDirectory() : !stats.isFile()) {
      throw new InvalidTerminalRuntimeRequestError();
    }
    return lexical;
  } catch (err: unknown) {
    if (err instanceof InvalidTerminalRuntimeRequestError) throw err;
    throw new InvalidTerminalRuntimeRequestError();
  }
}

function descriptorIdentityMatches(
  left: UserSystemdTerminalDescriptor,
  right: UserSystemdTerminalDescriptor,
): boolean {
  return left.version === right.version
    && left.runtimeId === right.runtimeId
    && left.sessionName === right.sessionName
    && left.scope === right.scope
    && left.kind === right.kind
    && left.displayName === right.displayName
    && left.cwd === right.cwd
    && left.layoutPath === right.layoutPath
    && left.environmentPath === right.environmentPath
    && left.generation === right.generation;
}

async function writeDescriptorExclusive(
  path: string,
  descriptor: UserSystemdTerminalDescriptor,
): Promise<UserSystemdTerminalDescriptor> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try {
      await link(tempPath, path);
      return descriptor;
    } catch (err: unknown) {
      if (!isErrnoCode(err, "EEXIST")) throw err;
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
        throw new TerminalRuntimeIdentityExistsError();
      }
      let parsedExisting: unknown;
      try {
        parsedExisting = JSON.parse(await readFile(path, "utf8"));
      } catch (err: unknown) {
        if (err instanceof SyntaxError) throw new TerminalRuntimeIdentityExistsError();
        throw err;
      }
      const existing = DescriptorSchema.safeParse(parsedExisting);
      if (!existing.success || !descriptorIdentityMatches(existing.data, descriptor)) {
        throw new TerminalRuntimeIdentityExistsError();
      }
      return existing.data;
    }
  } finally {
    await rm(tempPath, { force: true }).catch((err: unknown) => {
      if (!isErrnoCode(err, "ENOENT")) {
        console.warn("[terminal-runtime] failed to remove descriptor temp file");
      }
    });
  }
}

async function writeDescriptorAtomic(
  path: string,
  descriptor: UserSystemdTerminalDescriptor,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(tempPath, path);
  } catch (err: unknown) {
    await rm(tempPath, { force: true }).catch((cleanupErr: unknown) => {
      if (!isErrnoCode(cleanupErr, "ENOENT")) {
        console.warn("[terminal-runtime] failed to remove descriptor temp file");
      }
    });
    throw err;
  }
}

function unitName(runtimeId: string): string {
  return `matrix-zellij@${RuntimeIdSchema.parse(runtimeId)}.service`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function createUserSystemdTerminalRuntime(options: {
  homePath: string;
  uid?: number;
  generation: string;
  terminalRuntimeRoot?: string;
  runCommand?: UserSystemdCommandRunner;
  readinessProbe?: (descriptor: UserSystemdTerminalDescriptor) => Promise<boolean>;
  now?: () => string;
  readinessTimeoutMs?: number;
  generationLockHelperPath?: string;
  removePath?: (path: string) => Promise<void>;
}) {
  const homePath = resolve(options.homePath);
  const uid = options.uid ?? process.getuid?.();
  const generation = GenerationSchema.parse(options.generation);
  const terminalRuntimeRoot = resolve(options.terminalRuntimeRoot ?? "/opt/matrix/terminal-runtime");
  const runCommand = options.runCommand ?? defaultRunCommand;
  const now = options.now ?? (() => new Date().toISOString());
  const descriptorRoot = join(homePath, "system", "terminal-runtimes");
  const generationLockHelperPath = options.generationLockHelperPath;
  const removePath = options.removePath ?? ((path: string) => rm(path, { force: true }));
  let mutationTail = Promise.resolve();
  const systemdEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homePath,
    MATRIX_HOME: homePath,
    ...(uid == null ? {} : {
      XDG_RUNTIME_DIR: `/run/user/${uid}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
    }),
  };

  async function withCrossProcessGenerationLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!generationLockHelperPath) return operation();
    await ensureDescriptorRoot();
    const child = spawn("python3", [generationLockHelperPath, "--lock", descriptorRoot], {
      cwd: homePath,
      env: systemdEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => rejectReady(new TerminalRuntimeUnavailableError()), SYSTEMCTL_TIMEOUT_MS);
        timeout.unref?.();
        const cleanup = () => {
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          child.off("error", onError);
          child.off("exit", onExit);
        };
        const onData = (chunk: Buffer) => {
          if (chunk.toString("utf8") !== "locked\n") return;
          cleanup();
          resolveReady();
        };
        const onError = (err: Error) => {
          cleanup();
          rejectReady(new TerminalRuntimeUnavailableError(err));
        };
        const onExit = () => {
          cleanup();
          rejectReady(new TerminalRuntimeUnavailableError(new Error(stderr || "generation lock exited")));
        };
        child.stdout.on("data", onData);
        child.once("error", onError);
        child.once("exit", onExit);
      });
      return await operation();
    } finally {
      child.stdin.end();
      await new Promise<void>((resolveExit) => {
        if (child.exitCode !== null) return resolveExit();
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolveExit();
        }, SYSTEMCTL_TIMEOUT_MS);
        timeout.unref?.();
        child.once("exit", () => {
          clearTimeout(timeout);
          resolveExit();
        });
      });
    }
  }

  async function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await withCrossProcessGenerationLock(operation);
    } finally {
      release();
    }
  }

  async function ensureDescriptorRoot(): Promise<void> {
    await mkdir(descriptorRoot, { recursive: true, mode: 0o700 });
    try {
      const [homeReal, descriptorReal, stats] = await Promise.all([
        realpath(homePath),
        realpath(descriptorRoot),
        lstat(descriptorRoot),
      ]);
      if (!stats.isDirectory() || stats.isSymbolicLink() || !pathIsWithin(homeReal, descriptorReal)) {
        throw new InvalidTerminalRuntimeRequestError();
      }
    } catch (err: unknown) {
      if (err instanceof InvalidTerminalRuntimeRequestError) throw err;
      throw new InvalidTerminalRuntimeRequestError();
    }
  }

  async function defaultReadinessProbe(descriptor: UserSystemdTerminalDescriptor): Promise<boolean> {
    const zellijPath = join(terminalRuntimeRoot, "generations", descriptor.generation, "zellij");
    try {
      const { stdout } = await runCommand(zellijPath, ["list-sessions", "--no-formatting"], {
        cwd: descriptor.cwd,
        env: systemdEnv,
        timeoutMs: 2_000,
      });
      return stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[0] === descriptor.sessionName);
    } catch (err: unknown) {
      if (err instanceof Error) return false;
      throw err;
    }
  }

  const readinessProbe = options.readinessProbe ?? defaultReadinessProbe;

  async function waitUntilReady(descriptor: UserSystemdTerminalDescriptor): Promise<void> {
    const deadline = Date.now() + (options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS);
    do {
      if (await readinessProbe(descriptor)) return;
      await delay(READINESS_INTERVAL_MS);
    } while (Date.now() < deadline);
    throw new TerminalRuntimeUnavailableError();
  }

  async function runSystemctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await runCommand("systemctl", ["--user", ...args], {
        cwd: homePath,
        env: systemdEnv,
        timeoutMs: SYSTEMCTL_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      throw new TerminalRuntimeUnavailableError(err);
    }
  }

  async function readDescriptor(runtimeId: string): Promise<UserSystemdTerminalDescriptor | null> {
    const parsed = RuntimeIdSchema.safeParse(runtimeId);
    if (!parsed.success) throw new InvalidTerminalRuntimeRequestError();
    await ensureDescriptorRoot();
    const path = join(descriptorRoot, `${parsed.data}.json`);
    let stats;
    try {
      stats = await lstat(path);
    } catch (err: unknown) {
      if (isErrnoCode(err, "ENOENT")) return null;
      throw new TerminalRuntimeUnavailableError(err);
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
      throw new InvalidTerminalRuntimeRequestError();
    }
    let rawDescriptor: unknown;
    try {
      rawDescriptor = JSON.parse(await readFile(path, "utf8"));
    } catch (err: unknown) {
      if (err instanceof SyntaxError) throw new InvalidTerminalRuntimeRequestError();
      throw new TerminalRuntimeUnavailableError(err);
    }
    const descriptor = DescriptorSchema.safeParse(rawDescriptor);
    if (!descriptor.success || descriptor.data.runtimeId !== parsed.data) {
      throw new InvalidTerminalRuntimeRequestError();
    }
    return descriptor.data;
  }

  async function listDescriptors(): Promise<UserSystemdTerminalDescriptor[]> {
    await ensureDescriptorRoot();
    let entries;
    try {
      entries = await readdir(descriptorRoot, { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoCode(err, "ENOENT")) return [];
      throw new TerminalRuntimeUnavailableError();
    }
    const descriptors: UserSystemdTerminalDescriptor[] = [];
    const descriptorEntries = entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^rt_[0-9a-f]{32}\.json$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (descriptorEntries.length > MAX_RUNTIME_DESCRIPTORS) {
      throw new TerminalRuntimeUnavailableError();
    }
    for (const entry of descriptorEntries) {
      try {
        const descriptor = await readDescriptor(entry.name.slice(0, -".json".length));
        if (descriptor) descriptors.push(descriptor);
      } catch (err: unknown) {
        if (!(err instanceof InvalidTerminalRuntimeRequestError)) throw err;
        console.warn("[terminal-runtime] ignoring an invalid runtime descriptor");
      }
    }
    return descriptors;
  }

  async function isRunning(runtimeId: string): Promise<boolean> {
    const parsed = RuntimeIdSchema.safeParse(runtimeId);
    if (!parsed.success) throw new InvalidTerminalRuntimeRequestError();
    try {
      const { stdout } = await runSystemctl(["is-active", unitName(parsed.data)]);
      return stdout.trim() === "active";
    } catch (err: unknown) {
      const code: unknown = err instanceof Error && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
      if (code === 3 || code === 4 || code === "3" || code === "4") return false;
      throw err;
    }
  }

  async function startInterruptedRuntime(descriptor: UserSystemdTerminalDescriptor): Promise<void> {
    await runSystemctl(["start", unitName(descriptor.runtimeId)]);
    try {
      await waitUntilReady(descriptor);
      return;
    } catch (err: unknown) {
      if (!(err instanceof TerminalRuntimeUnavailableError) || await isRunning(descriptor.runtimeId)) {
        throw err;
      }
    }
    const zellijPath = join(terminalRuntimeRoot, "generations", descriptor.generation, "zellij");
    try {
      await runCommand(zellijPath, ["delete-session", descriptor.sessionName, "--force"], {
        cwd: descriptor.cwd,
        env: systemdEnv,
        timeoutMs: SYSTEMCTL_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      const code: unknown = err instanceof Error && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
      if (code !== 2 && code !== "2") throw new TerminalRuntimeUnavailableError(err);
    }
    await delay(INACTIVE_RECOVERY_RETRY_DELAY_MS);
    await runSystemctl(["start", unitName(descriptor.runtimeId)]);
    await waitUntilReady(descriptor);
  }

  return {
    async create(input: CreateUserSystemdRuntimeInput): Promise<UserSystemdRuntimeResult> {
      const parsed = z.object({
        runtimeId: RuntimeIdSchema,
        scope: RuntimeScopeSchema,
        kind: z.enum(["shell", "agent"]),
        displayName: DisplayNameSchema,
        cwd: z.string().min(1).max(4096),
        layoutPath: z.string().min(1).max(4096),
        environmentPath: z.string().min(1).max(4096).optional(),
      }).strict().safeParse(input);
      if (!parsed.success) throw new InvalidTerminalRuntimeRequestError();
      const [cwd, layoutPath, environmentPath] = await Promise.all([
        validateOwnedPath(homePath, parsed.data.cwd, "directory"),
        validateOwnedPath(homePath, parsed.data.layoutPath, "file"),
        parsed.data.environmentPath
          ? validateOwnedPath(homePath, parsed.data.environmentPath, "file")
          : Promise.resolve(undefined),
      ]);
      const descriptor = DescriptorSchema.parse({
        version: 1,
        runtimeId: parsed.data.runtimeId,
        sessionName: `matrix-${parsed.data.runtimeId}`,
        scope: parsed.data.scope,
        kind: parsed.data.kind,
        displayName: parsed.data.displayName,
        cwd,
        layoutPath,
        ...(environmentPath ? { environmentPath } : {}),
        generation,
        createdAt: now(),
      });
      return withMutationLock(async () => {
        const descriptors = await listDescriptors();
        if (descriptors.some((entry) => (
          entry.runtimeId !== descriptor.runtimeId
          && entry.scope === descriptor.scope
          && entry.displayName === descriptor.displayName
        ))) {
          throw new TerminalRuntimeIdentityExistsError();
        }
        if (
          descriptors.length >= MAX_RUNTIME_DESCRIPTORS
          && !descriptors.some((entry) => entry.runtimeId === descriptor.runtimeId)
        ) {
          throw new TerminalRuntimeUnavailableError();
        }
        const persisted = await writeDescriptorExclusive(
          join(descriptorRoot, `${descriptor.runtimeId}.json`),
          descriptor,
        );
        await runSystemctl(["start", unitName(persisted.runtimeId)]);
        await waitUntilReady(persisted);
        return { ...persisted, lifecycle: "running" };
      });
    },

    async start(runtimeId: string): Promise<UserSystemdRuntimeResult> {
      const descriptor = await readDescriptor(runtimeId);
      if (!descriptor) throw new InvalidTerminalRuntimeRequestError();
      await startInterruptedRuntime(descriptor);
      return { ...descriptor, lifecycle: "running" };
    },

    get(runtimeId: string): Promise<UserSystemdTerminalDescriptor | null> {
      return readDescriptor(runtimeId);
    },

    async list(input: {
      scope?: "terminal" | "workspace";
      kind?: "shell" | "agent";
      runningOnly?: boolean;
    } = {}): Promise<UserSystemdTerminalDescriptor[]> {
      let descriptors = await listDescriptors();
      if (input.scope) descriptors = descriptors.filter((entry) => entry.scope === input.scope);
      if (input.kind) descriptors = descriptors.filter((entry) => entry.kind === input.kind);
      if (input.runningOnly) {
        const running: UserSystemdTerminalDescriptor[] = [];
        for (let index = 0; index < descriptors.length; index += 8) {
          const batch = descriptors.slice(index, index + 8);
          const results = await Promise.all(batch.map(async (entry) => ({
            entry,
            running: await isRunning(entry.runtimeId),
          })));
          running.push(...results.filter((result) => result.running).map((result) => result.entry));
        }
        descriptors = running;
      }
      return descriptors;
    },

    async findByDisplayName(
      scope: "terminal" | "workspace",
      displayName: string,
    ): Promise<UserSystemdTerminalDescriptor | null> {
      const parsedScope = RuntimeScopeSchema.safeParse(scope);
      const parsedName = DisplayNameSchema.safeParse(displayName);
      if (!parsedScope.success || !parsedName.success) throw new InvalidTerminalRuntimeRequestError();
      return (await listDescriptors()).find((entry) => (
        entry.scope === parsedScope.data && entry.displayName === parsedName.data
      )) ?? null;
    },

    isRunning,

    async renameDisplayName(runtimeId: string, displayName: string): Promise<UserSystemdTerminalDescriptor> {
      const parsedName = DisplayNameSchema.safeParse(displayName);
      if (!parsedName.success) throw new InvalidTerminalRuntimeRequestError();
      return withMutationLock(async () => {
        const existing = await readDescriptor(runtimeId);
        if (!existing || existing.scope !== "terminal") throw new InvalidTerminalRuntimeRequestError();
        const conflict = (await listDescriptors()).some((entry) => (
          entry.scope === "terminal"
          && entry.runtimeId !== existing.runtimeId
          && entry.displayName === parsedName.data
        ));
        if (conflict) throw new TerminalRuntimeIdentityExistsError();
        const next = DescriptorSchema.parse({ ...existing, displayName: parsedName.data });
        await writeDescriptorAtomic(join(descriptorRoot, `${existing.runtimeId}.json`), next);
        return next;
      });
    },

    async delete(runtimeId: string): Promise<{ ok: true }> {
      const parsed = RuntimeIdSchema.safeParse(runtimeId);
      if (!parsed.success) throw new InvalidTerminalRuntimeRequestError();
      return withMutationLock(async () => {
        const descriptor = await readDescriptor(parsed.data);
        await runSystemctl(["stop", unitName(parsed.data)]);
        try {
          const generatedLayoutRoot = join(homePath, "system", "zellij", "runtime-layouts");
          const generatedEnvironmentRoot = join(descriptorRoot, "env");
          if (
            descriptor?.environmentPath
            && dirname(descriptor.environmentPath) === generatedEnvironmentRoot
            && basename(descriptor.environmentPath).startsWith(`${descriptor.runtimeId}-`)
            && basename(descriptor.environmentPath).endsWith(".json")
          ) {
            await removePath(descriptor.environmentPath);
          }
          if (
            descriptor
            && dirname(descriptor.layoutPath) === generatedLayoutRoot
            && basename(descriptor.layoutPath).startsWith(`${descriptor.runtimeId}`)
            && basename(descriptor.layoutPath).endsWith(".kdl")
          ) {
            await removePath(descriptor.layoutPath);
          }
          await removePath(join(descriptorRoot, `${parsed.data}.json`));
        } catch (err: unknown) {
          if (err instanceof TerminalRuntimeUnavailableError) throw err;
          throw new TerminalRuntimeUnavailableError(err);
        }
        return { ok: true };
      });
    },
  };
}
