import { codexNativeEnvironment } from "./codex-native-environment.js";
import { resolveCodexNativeExecutable } from "./codex-native-terminal-command.js";
import { createCodexNativeAccountMetadataReader, type CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";
import { NativeProviderWriteNotStartedError } from "./native-provider-profile-guard.js";
import { resolveClaudeNativeExecutable } from "./claude-native-executable.js";
import { isBoundClaudeNativeSignedOut, verifyClaudeNativeSignedOut } from "./claude-native-signed-out.js";
import { createClaudeAccountReaderUnderLease, assertClaudeLifecyclePrincipal, assertClaudeLifecycleSignedOut, type ClaudeAccountReaderUnderLease } from "./claude-account-lifecycle-proof.js";
import { isNativeClaudeLifecycleAccount } from "./provider-lifecycle-credential-identity.js";
import { hasNativeAccountCredentialIdentity, sameBoundNativeAccountPrincipal, verifyNativeAccountMetadata } from "./native-account-metadata-binding.js";
import { revokeOwnerAnthropicKey } from "./owner-anthropic-key.js";
import type { NativeProviderProfileGuard } from "./native-provider-profile-guard.js";
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
    && account.providerId === "anthropic" && (account.authMethod === "terminal" || account.authMethod === "api_key" && account.accessSourceId === "owner_anthropic_key")) {
    return "claude_code";
  }
  if (account.driverId === "codex" && account.harness === "codex"
    && account.providerId === "openai"
    && (account.authMethod === "terminal" || account.authMethod === "oauth" || account.authMethod === "api_key")) {
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
  profileGuard?: NativeProviderProfileGuard;
  readClaudeAccountUnderLease?: ClaudeAccountReaderUnderLease;
  readCodexAccountUnderLease?: () => Promise<CodexNativeAccountMetadata | null>;
}): ProviderAccountLifecycleCoordinator {
  if (!options.homePath) throw new Error("Provider lifecycle home path is required");
  const homePath = resolve(options.homePath);
  const enabled = new Set(EnabledDriverSchema.array().max(2).parse(options.enabledDriverIds));
  const receiptsPath = join(homePath, "system/ai-providers/lifecycle-receipts.json");
  const run = options.run ?? defaultRun;
  const readClaudeUnderLease = options.readClaudeAccountUnderLease
    ?? createClaudeAccountReaderUnderLease(homePath, lifecycleEnvironment(homePath));
  const readCodexUnderLease = options.readCodexAccountUnderLease ?? (async () => {
    const environment = codexNativeEnvironment(homePath, buildAgentRuntimeEnvironment(homePath), process.env.CODEX_HOME);
    return createCodexNativeAccountMetadataReader({ executable: resolveCodexNativeExecutable(homePath, environment), cwd: homePath, environment })();
  });
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
    const nativeKey = account.id === "owner_codex" && account.accessSourceId === "owner_openai_profile"
      && (account.authMethod === "api_key" || account.nativeCodexAccount?.authMethod === "api_key");
    return driver !== null && enabled.has(driver)
      && account.installState === "installed" && account.driverAccountCount === 1
      && (!nativeKey || Boolean(options.profileGuard && hasNativeAccountCredentialIdentity(account.nativeCodexAccount)))
      && (!isNativeClaudeLifecycleAccount(account) || Boolean(options.profileGuard && (account.authenticated
        ? account.nativeClaudeAccount && sameBoundNativeAccountPrincipal(account.nativeClaudeAccount, account.nativeClaudeAccount)
        : isBoundClaudeNativeSignedOut(account.nativeClaudeSignedOut, homePath))));
  }

  async function apply(action: LifecycleAction, input: {
    account: ProviderLifecycleAccount;
    idempotencyKey: string;
  }): Promise<void> {
    const applyNative = () => serialize(async () => {
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
      // Reject proven no-effect invalid targets before acquiring a durable writer.
      if (input.account.installState !== "installed" || input.account.driverAccountCount !== 1
        || action === "logout_account" && !input.account.authenticated) {
        throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
      }
      const nativeCodex = driver === "codex" && (input.account.authMethod === "terminal"
        || input.account.id === "owner_codex" && input.account.accessSourceId === "owner_openai_profile");
      if (nativeCodex && (!options.profileGuard || input.account.id !== "owner_codex" || input.account.accessSourceId !== "owner_openai_profile"
        || (input.account.nativeCodexAccount?.authMethod === "api_key" && !hasNativeAccountCredentialIdentity(input.account.nativeCodexAccount))
        || (input.account.authenticated ? !await verifyNativeAccountMetadata(input.account.nativeCodexAccount) : action !== "remove_account"))) throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
      const nativeClaude = isNativeClaudeLifecycleAccount(input.account);
      if (nativeClaude && (!options.profileGuard
        || !(input.account.authenticated
          ? await verifyNativeAccountMetadata(input.account.nativeClaudeAccount)
          : action === "remove_account" && await verifyClaudeNativeSignedOut(input.account.nativeClaudeSignedOut, homePath)))) {
        throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
      }
      const mutateProfile = async () => {
        if (nativeCodex) {
          if (input.account.authenticated) {
            const current = await readCodexUnderLease();
            if (!current || !input.account.nativeCodexAccount || !sameBoundNativeAccountPrincipal(current, input.account.nativeCodexAccount)
              || current.authMethod === "api_key" && !hasNativeAccountCredentialIdentity(current)
              || !await verifyNativeAccountMetadata(current)) throw new NativeProviderWriteNotStartedError();
          } else {
            const env = codexNativeEnvironment(homePath, buildAgentRuntimeEnvironment(homePath), process.env.CODEX_HOME);
            let signedOut = false;
            let phase: "resolve_executable" | "login_status" = "resolve_executable";
            try {
              const executable = resolveCodexNativeExecutable(homePath, env);
              phase = "login_status";
              await run(executable, ["login", "status"], {
                cwd: homePath, env, timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES,
              });
            } catch (error: unknown) {
              // Only the official CLI's exact signed-out response proves absence.
              // Missing executables, timeouts, unknown output, and successful key or
              // subscription status must never authorize removal or trigger logout.
              if (error instanceof Error && "code" in error && error.code === 1
                && "stdout" in error && typeof error.stdout === "string"
                && "stderr" in error && typeof error.stderr === "string") {
                signedOut = `${error.stdout}${error.stderr}`.trim() === "Not logged in";
              }
              if (!signedOut) {
                // Exception names, messages and command output may contain private data.
                const code = error instanceof Error && "code" in error
                  && (error.code === "ENOENT" || error.code === "ETIMEDOUT" || error.code === 1) ? error.code : "unknown";
                console.warn("[provider-lifecycle] Native sign-out status unavailable:", { phase, code });
              }
            }
            if (!signedOut) throw new NativeProviderWriteNotStartedError();
          }
        }
        if (nativeClaude) {
          if (input.account.authenticated) await assertClaudeLifecyclePrincipal(input.account.nativeClaudeAccount, readClaudeUnderLease);
          else await assertClaudeLifecycleSignedOut(homePath, readClaudeUnderLease);
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
          if (driver === "claude_code" && input.account.authMethod === "api_key") {
            await revokeOwnerAnthropicKey(homePath);
          } else {
          const command = COMMANDS[driver];
          CommandResultSchema.parse(await run(driver === "claude_code" ? resolveClaudeNativeExecutable(homePath, lifecycleEnvironment(homePath)) : nativeCodex ? resolveCodexNativeExecutable(homePath, codexNativeEnvironment(homePath, buildAgentRuntimeEnvironment(homePath), process.env.CODEX_HOME)) : command.command, [...command.args], {
            cwd: homePath,
            timeoutMs: COMMAND_TIMEOUT_MS,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            env: nativeCodex ? codexNativeEnvironment(homePath, buildAgentRuntimeEnvironment(homePath), process.env.CODEX_HOME) : lifecycleEnvironment(homePath),
          }));
          }
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
      };
      if (options.profileGuard) await options.profileGuard.run(driver === "codex" ? "codex" : "claude", { kind: "write" }, mutateProfile);
      else await mutateProfile();
    });
    await applyNative();
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
  profileGuard?: NativeProviderProfileGuard;
  readClaudeAccountUnderLease?: ClaudeAccountReaderUnderLease;
  readCodexAccountUnderLease?: () => Promise<CodexNativeAccountMetadata | null>;
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
    ...(options.profileGuard ? { profileGuard: options.profileGuard } : {}),
    ...(options.readCodexAccountUnderLease ? { readCodexAccountUnderLease: options.readCodexAccountUnderLease } : {}),
    ...(options.readClaudeAccountUnderLease ? { readClaudeAccountUnderLease: options.readClaudeAccountUnderLease } : {}),
  });
}
