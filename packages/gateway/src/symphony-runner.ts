import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod/v4";

const SYMPHONY_CONFIG_VERSION = 1;
const SYMPHONY_STOP_TIMEOUT_MS = 5_000;
const SYMPHONY_START_SETTLE_MS = 25;
const GUARDRAILS_FLAG = "--i-understand-that-this-will-be-running-without-the-usual-guardrails";
const SYMPHONY_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "MIX_ENV",
  "ERL_AFLAGS",
  "ELIXIR_ERL_OPTIONS",
  "MISE_DATA_DIR",
  "MISE_CONFIG_DIR",
  "MISE_CACHE_DIR",
];
const SYMPHONY_ENV_DENYLIST = new Set([
  "DATABASE_URL",
  "MATRIX_AUTH_TOKEN",
  "PLATFORM_INTERNAL_TOKEN",
  "PLATFORM_INTERNAL_URL",
  "PIPEDREAM_CLIENT_ID",
  "PIPEDREAM_CLIENT_SECRET",
  "PIPEDREAM_PROJECT_ID",
  "PIPEDREAM_PROJECT_ENVIRONMENT",
  "CLERK_SECRET_KEY",
  "UPGRADE_TOKEN",
]);
const SYMPHONY_ENV_DENY_PREFIXES = ["PIPEDREAM_", "CLERK_", "CUSTOMER_VPS_"];

const LocalPathSchema = z.string()
  .min(1)
  .max(2048)
  .refine((value) => !value.includes("\0"), "Path must not contain NUL bytes");

const RelativeCommandSchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "Command path must not contain NUL bytes")
  .refine((value) => {
    if (isAbsolute(value)) return true;
    return !value.split("/").some((part) => part === "..");
  }, "Relative command path must not contain parent traversal");

export const SymphonyTrackerConfigSchema = z.object({
  kind: z.literal("linear"),
  teamKey: z.string().min(1).max(32).default("MAT"),
  requiredLabels: z.array(z.string().min(1).max(64)).max(20).default(["symphony"]),
  activeStates: z.array(z.string().min(1).max(64)).min(1).max(20).default([
    "Todo",
    "In Progress",
    "Merging",
    "Rework",
  ]),
});

export const SymphonyConfigSchema = z.object({
  version: z.literal(SYMPHONY_CONFIG_VERSION).default(SYMPHONY_CONFIG_VERSION),
  serviceRoot: LocalPathSchema.default(() => join(homedir(), "code", "symphony", "elixir")),
  binPath: RelativeCommandSchema.default("./bin/symphony"),
  workflowPath: LocalPathSchema.default(() => join(process.cwd(), "WORKFLOW.md")),
  port: z.number().int().min(1024).max(65535).default(4066),
  tracker: SymphonyTrackerConfigSchema.default({
    kind: "linear",
    teamKey: "MAT",
    requiredLabels: ["symphony"],
    activeStates: ["Todo", "In Progress", "Merging", "Rework"],
  }),
});

export const SymphonyTrackerConfigUpdateSchema = z.object({
  kind: z.literal("linear").optional(),
  teamKey: z.string().min(1).max(32).optional(),
  requiredLabels: z.array(z.string().min(1).max(64)).max(20).optional(),
  activeStates: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
});

export const SymphonyConfigUpdateSchema = z.object({
  version: z.literal(SYMPHONY_CONFIG_VERSION).optional(),
  serviceRoot: LocalPathSchema.optional(),
  binPath: RelativeCommandSchema.optional(),
  workflowPath: LocalPathSchema.optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  tracker: SymphonyTrackerConfigUpdateSchema.optional(),
});

export type SymphonyConfig = z.infer<typeof SymphonyConfigSchema>;
export type SymphonyConfigUpdate = z.infer<typeof SymphonyConfigUpdateSchema>;

export type SymphonyStatus = {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  lastExitAt: string | null;
  lastExitCode: number | null;
  dashboardUrl: string;
  linearApiKeyConfigured: boolean;
  config: SymphonyConfig;
};

export type SymphonyStartResult =
  | { ok: true; status: SymphonyStatus }
  | { ok: false; status: number; code: string; message: string };

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type SymphonyRunnerOptions = {
  homePath: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
};

export function createSymphonyRunner(options: SymphonyRunnerOptions) {
  return new SymphonyRunner(options);
}

class SymphonyRunner {
  private readonly homePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnProcess: SpawnProcess;
  private readonly configPath: string;
  private process: ChildProcess | null = null;
  private startInFlight: Promise<SymphonyStartResult> | null = null;
  private startedAt: string | null = null;
  private lastExitAt: string | null = null;
  private lastExitCode: number | null = null;

  constructor(options: SymphonyRunnerOptions) {
    this.homePath = resolve(options.homePath);
    this.env = options.env ?? process.env;
    this.spawnProcess = options.spawnProcess ?? nodeSpawn;
    this.configPath = join(this.homePath, "system", "symphony.json");
  }

  async getConfig(): Promise<SymphonyConfig> {
    let stored: unknown = {};
    try {
      stored = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return SymphonyConfigSchema.parse({});
      }
      console.error("[symphony] Failed to load config:", err);
      return SymphonyConfigSchema.parse({});
    }
    const parsed = SymphonyConfigUpdateSchema.safeParse(stored);
    if (!parsed.success) {
      console.error("[symphony] Ignoring invalid config");
      return SymphonyConfigSchema.parse({});
    }
    return this.mergeConfig(parsed.data);
  }

  async saveConfig(update: SymphonyConfigUpdate): Promise<SymphonyConfig> {
    const current = await this.getConfig();
    const next = this.mergeConfig(update, current);
    const systemPath = join(this.homePath, "system");
    await mkdir(systemPath, { recursive: true });
    const tempPath = join(systemPath, `.symphony-${randomUUID()}.json.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
      await rename(tempPath, this.configPath);
    } catch (err: unknown) {
      await removeTempFile(tempPath);
      throw err;
    }
    return next;
  }

  async status(): Promise<SymphonyStatus> {
    const config = await this.getConfig();
    return this.statusFor(config);
  }

  async start(update?: SymphonyConfigUpdate): Promise<SymphonyStartResult> {
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.startUnlocked(update).finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private async startUnlocked(update?: SymphonyConfigUpdate): Promise<SymphonyStartResult> {
    if (this.process && !this.process.killed) {
      return { ok: true, status: await this.status() };
    }
    if (!this.env.LINEAR_API_KEY) {
      return {
        ok: false,
        status: 409,
        code: "missing_linear_api_key",
        message: "LINEAR_API_KEY is required to run Symphony",
      };
    }

    const config = update ? await this.saveConfig(update) : await this.getConfig();
    const serviceRoot = expandLocalPath(config.serviceRoot);
    const workflowPath = expandLocalPath(config.workflowPath);
    const command = isAbsolute(config.binPath) ? expandLocalPath(config.binPath) : config.binPath;
    const commandPath = isAbsolute(command) ? command : resolve(serviceRoot, command);

    const pathPolicy = validateRunnerPaths({
      homePath: this.homePath,
      serviceRoot,
      workflowPath,
      commandPath,
    });
    if (!pathPolicy.ok) {
      return {
        ok: false,
        status: 400,
        code: pathPolicy.code,
        message: pathPolicy.message,
      };
    }

    const missing = await firstUnavailablePath([
      { label: "serviceRoot", path: serviceRoot, mode: fsConstants.R_OK | fsConstants.X_OK },
      { label: "workflowPath", path: workflowPath, mode: fsConstants.R_OK },
      { label: "binPath", path: commandPath, mode: fsConstants.X_OK },
    ]);
    if (missing) {
      return {
        ok: false,
        status: 409,
        code: "symphony_not_installed",
        message: `Symphony ${missing.label} is not available`,
      };
    }

    const runId = randomUUID();
    const child = this.spawnProcess(commandPath, [
      workflowPath,
      "--port",
      String(config.port),
      GUARDRAILS_FLAG,
    ], {
      cwd: serviceRoot,
      env: buildSymphonyEnv(this.env, this.homePath, runId),
      stdio: "ignore",
      detached: false,
    });

    this.process = child;
    this.startedAt = new Date().toISOString();
    this.lastExitAt = null;
    this.lastExitCode = null;

    child.once("exit", (code) => {
      if (this.process === child) {
        this.process = null;
      }
      this.lastExitAt = new Date().toISOString();
      this.lastExitCode = typeof code === "number" ? code : null;
    });
    child.once("error", (err) => {
      if (this.process === child) {
        this.process = null;
      }
      this.lastExitAt = new Date().toISOString();
      this.lastExitCode = null;
      console.error("[symphony] Failed to start local runner:", err);
    });

    const startupFailure = await waitForStartupFailure(child);
    if (startupFailure) {
      if (this.process === child) {
        this.process = null;
      }
      this.lastExitAt ??= new Date().toISOString();
      return {
        ok: false,
        status: 409,
        code: "symphony_start_failed",
        message: "Symphony runner failed to start",
      };
    }

    return { ok: true, status: this.statusFor(config) };
  }

  async stop(): Promise<SymphonyStatus> {
    const startInFlight = this.startInFlight;
    if (startInFlight) {
      try {
        await startInFlight;
      } catch (err: unknown) {
        console.error("[symphony] Start failed while stopping local runner:", err);
      }
    }
    const child = this.process;
    if (!child) return this.status();

    await new Promise<void>((resolveStop) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolveStop();
      };
      const killTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        finish();
      }, SYMPHONY_STOP_TIMEOUT_MS);
      child.once("exit", finish);
      child.kill("SIGTERM");
    });

    if (this.process === child) {
      this.process = null;
    }
    this.lastExitAt ??= new Date().toISOString();
    return this.status();
  }

  private mergeConfig(update: SymphonyConfigUpdate, base?: SymphonyConfig): SymphonyConfig {
    const current = base ?? SymphonyConfigSchema.parse({});
    return SymphonyConfigSchema.parse({
      ...current,
      ...update,
      tracker: {
        ...current.tracker,
        ...(update.tracker ?? {}),
      },
    });
  }

  private statusFor(config: SymphonyConfig): SymphonyStatus {
    const running = Boolean(this.process && !this.process.killed);
    return {
      running,
      pid: running ? this.process?.pid ?? null : null,
      startedAt: running ? this.startedAt : null,
      lastExitAt: this.lastExitAt,
      lastExitCode: this.lastExitCode,
      dashboardUrl: `http://127.0.0.1:${config.port}`,
      linearApiKeyConfigured: Boolean(this.env.LINEAR_API_KEY),
      config,
    };
  }
}

function expandLocalPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function validateRunnerPaths(paths: {
  homePath: string;
  serviceRoot: string;
  workflowPath: string;
  commandPath: string;
}): { ok: true } | { ok: false; code: string; message: string } {
  const serviceRoots = [
    resolve(homedir(), "code", "symphony"),
    resolve(paths.homePath, "code", "symphony"),
  ];
  if (!serviceRoots.some((root) => isWithinPath(root, paths.serviceRoot))) {
    return {
      ok: false,
      code: "symphony_path_not_allowed",
      message: "Symphony runner path is not allowed",
    };
  }
  if (!isWithinPath(paths.serviceRoot, paths.commandPath)) {
    return {
      ok: false,
      code: "symphony_path_not_allowed",
      message: "Symphony runner path is not allowed",
    };
  }

  const workflowRoots = [
    resolve(process.cwd()),
    resolve(paths.homePath),
  ];
  if (!workflowRoots.some((root) => isWithinPath(root, paths.workflowPath))) {
    return {
      ok: false,
      code: "symphony_workflow_path_not_allowed",
      message: "Symphony workflow path is not allowed",
    };
  }

  return { ok: true };
}

function isWithinPath(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  const childRelativePath = relative(resolvedParent, resolvedChild);
  return childRelativePath === "" || (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath));
}

async function firstUnavailablePath(
  paths: Array<{ label: string; path: string; mode: number }>,
): Promise<{ label: string } | null> {
  for (const { label, path, mode } of paths) {
    try {
      await access(path, mode);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err) {
        return { label };
      }
      console.error("[symphony] Unexpected path availability error:", err);
      return { label };
    }
  }
  return null;
}

function buildSymphonyEnv(baseEnv: NodeJS.ProcessEnv, homePath: string, runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SYMPHONY_ENV_ALLOWLIST) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  for (const key of parseExtraEnvAllowlist(baseEnv.MATRIX_SYMPHONY_ENV_ALLOWLIST)) {
    if (isDeniedSymphonyEnvKey(key)) continue;
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  env.LINEAR_API_KEY = baseEnv.LINEAR_API_KEY;
  env.MATRIX_HOME = homePath;
  env.MATRIX_SYMPHONY_RUN_ID = runId;
  return env;
}

function parseExtraEnvAllowlist(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => /^[A-Z0-9_]{1,128}$/.test(key));
}

function isDeniedSymphonyEnvKey(key: string): boolean {
  return SYMPHONY_ENV_DENYLIST.has(key) || SYMPHONY_ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

async function waitForStartupFailure(child: ChildProcess): Promise<boolean> {
  return new Promise((resolveStartup) => {
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      resolveStartup(failed);
    };
    const onError = () => finish(true);
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), SYMPHONY_START_SETTLE_MS);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function removeTempFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return;
    }
    console.error("[symphony] Failed to clean up temporary config file:", err);
  }
}
