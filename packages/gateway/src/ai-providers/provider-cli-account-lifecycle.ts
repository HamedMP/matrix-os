import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";
import { writeProviderJsonAtomic } from "./provider-settings-persistence.js";
import type {
  ProviderAccountLifecycleCoordinator,
  ProviderLifecycleAccount,
} from "./provider-settings-coordinators.js";

const MAX_RECEIPTS = 64;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const SafeRefSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const EnabledDriverSchema = z.enum(["codex", "claude_code"]);
const ReceiptSchema = z.object({
  key: SafeRefSchema,
  payloadHash: z.string().length(64).regex(/^[a-f0-9]+$/),
  state: z.enum(["pending", "completed", "failed"]),
}).strict();
const ReceiptDocumentSchema = z.object({
  version: z.literal(1),
  receipts: z.array(ReceiptSchema).max(MAX_RECEIPTS),
}).strict();
const CommandResultSchema = z.object({
  stdout: z.string().max(MAX_OUTPUT_BYTES),
  stderr: z.string().max(MAX_OUTPUT_BYTES),
}).strict();

type LifecycleAction = "logout_account" | "remove_account";
type CommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    env: Record<string, string>;
  },
) => Promise<{ stdout: string; stderr: string }>;

const COMMANDS = {
  codex: { command: "codex", args: ["logout"] },
  claude_code: { command: "claude", args: ["auth", "logout"] },
} as const;
const INHERITED_AUTH_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
] as const;

const execFileAsync = promisify(execFile);
const defaultRun: CommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    maxBuffer: options.maxOutputBytes,
    env: options.env,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function lifecycleEnvironment(homePath: string): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  Object.assign(environment, buildAgentRuntimeEnvironment(homePath));
  for (const key of INHERITED_AUTH_ENVIRONMENT) delete environment[key];
  return environment;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readReceipts(path: string) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_FILE_BYTES) {
      throw new Error("Unsafe provider lifecycle receipt file");
    }
    return ReceiptDocumentSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissing(error)) return { version: 1 as const, receipts: [] };
    throw error;
  }
}

function accountDriver(account: ProviderLifecycleAccount): "codex" | "claude_code" | null {
  if (account.driverId === "claude_code" && account.harness === "claude"
    && account.providerId === "anthropic" && account.authMethod === "terminal") {
    return "claude_code";
  }
  if (account.driverId === "codex" && account.harness === "codex"
    && account.providerId === "openai"
    && (account.authMethod === "terminal" || account.authMethod === "oauth")) {
    return "codex";
  }
  return null;
}

function payloadHash(action: LifecycleAction, account: ProviderLifecycleAccount): string {
  return createHash("sha256").update(JSON.stringify({
    action,
    account: {
      id: account.id,
      providerId: account.providerId,
      authMethod: account.authMethod,
      accessSourceId: account.accessSourceId,
      driverId: account.driverId,
      harness: account.harness,
    },
  })).digest("hex");
}

export function createProviderCliAccountLifecycleCoordinator(options: {
  homePath: string;
  enabledDriverIds: readonly ("codex" | "claude_code")[];
  run?: CommandRunner;
}): ProviderAccountLifecycleCoordinator {
  if (!options.homePath) throw new Error("Provider lifecycle home path is required");
  const homePath = resolve(options.homePath);
  const enabled = new Set(EnabledDriverSchema.array().max(2).parse(options.enabledDriverIds));
  const receiptsPath = join(homePath, "system/ai-providers/lifecycle-receipts.json");
  const run = options.run ?? defaultRun;
  if (typeof run !== "function") throw new Error("Provider lifecycle command runner is required");
  let tail: Promise<void> = Promise.resolve();

  async function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolveTail) => { release = resolveTail; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  function supported(account: ProviderLifecycleAccount): boolean {
    const driver = accountDriver(account);
    return driver !== null && enabled.has(driver)
      && account.installState === "installed" && account.driverAccountCount === 1;
  }

  async function apply(action: LifecycleAction, input: {
    account: ProviderLifecycleAccount;
    idempotencyKey: string;
  }): Promise<void> {
    await serialize(async () => {
      const driver = accountDriver(input.account);
      if (driver === null || !enabled.has(driver)) {
        throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
      }
      const key = SafeRefSchema.parse(input.idempotencyKey);
      const hash = payloadHash(action, input.account);
      const document = await readReceipts(receiptsPath);
      const existing = document.receipts.find((receipt) => receipt.key === key);
      if (existing?.payloadHash !== undefined && existing.payloadHash !== hash) {
        throw new ProviderSettingsStoreError("idempotency_conflict", 409);
      }
      if (existing?.state === "completed") return;
      if (existing?.state === "pending") {
        throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
      }
      if (input.account.installState !== "installed" || input.account.driverAccountCount !== 1
        || (action === "logout_account" && !input.account.authenticated)) {
        throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
      }
      if (existing) existing.state = "pending";
      else document.receipts.push({ key, payloadHash: hash, state: "pending" });
      if (document.receipts.length > MAX_RECEIPTS) {
        document.receipts.splice(0, document.receipts.length - MAX_RECEIPTS);
      }
      await writeProviderJsonAtomic(receiptsPath, ReceiptDocumentSchema.parse(document));
      const receipt = document.receipts.find((candidate) => candidate.key === key);
      if (!receipt) throw new Error("Provider lifecycle receipt was evicted");
      if (action === "remove_account" && !input.account.authenticated) {
        receipt.state = "completed";
        try {
          await writeProviderJsonAtomic(receiptsPath, ReceiptDocumentSchema.parse(document));
          return;
        } catch (error) {
          console.warn(
            "[provider-lifecycle] Failed to persist command completion:",
            error instanceof Error ? error.name : "UnknownError",
          );
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
      }
      try {
        const command = COMMANDS[driver];
        CommandResultSchema.parse(await run(command.command, [...command.args], {
          cwd: homePath,
          timeoutMs: COMMAND_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          env: lifecycleEnvironment(homePath),
        }));
      } catch (error) {
        receipt.state = "failed";
        await writeProviderJsonAtomic(receiptsPath, ReceiptDocumentSchema.parse(document)).catch(
          (persistError: unknown) => console.warn(
            "[provider-lifecycle] Failed to persist safe command failure:",
            persistError instanceof Error ? persistError.name : "UnknownError",
          ),
        );
        console.warn(
          "[provider-lifecycle] Provider command failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
        throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
      }
      receipt.state = "completed";
      try {
        await writeProviderJsonAtomic(receiptsPath, ReceiptDocumentSchema.parse(document));
      } catch (error) {
        console.warn(
          "[provider-lifecycle] Failed to persist command completion:",
          error instanceof Error ? error.name : "UnknownError",
        );
        throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
      }
    });
  }

  return {
    supportedActions(account) {
      if (!supported(account)) return [];
      return account.authenticated
        ? ["logout_account", "remove_account"]
        : ["remove_account"];
    },
    async logout(input) {
      await apply("logout_account", input);
    },
    async remove(input) {
      await apply("remove_account", input);
    },
  };
}

export function createDefaultProviderCliAccountLifecycleCoordinator(options: {
  homePath: string;
  enabledHarnesses: readonly ("codex" | "claude" | "opencode" | "pi")[];
  run?: CommandRunner;
}): ProviderAccountLifecycleCoordinator {
  const enabledHarnesses = z.enum(["codex", "claude", "opencode", "pi"]).array().max(4)
    .parse(options.enabledHarnesses);
  return createProviderCliAccountLifecycleCoordinator({
    homePath: options.homePath,
    enabledDriverIds: enabledHarnesses.flatMap((harness) => {
      if (harness === "codex") return ["codex" as const];
      if (harness === "claude") return ["claude_code" as const];
      return [];
    }),
    ...(options.run ? { run: options.run } : {}),
  });
}
