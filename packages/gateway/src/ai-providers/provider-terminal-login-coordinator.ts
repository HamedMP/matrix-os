import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderConnectionAttemptSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { ShellRegistry } from "../shell/registry.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";
import { writeProviderJsonAtomic } from "./provider-settings-persistence.js";
import type { ProviderLoginCoordinator } from "./provider-settings-coordinators.js";
import { currentProviderConnectionAttempt } from "./provider-settings-receipts.js";

const MAX_RECEIPTS = 64;
const MAX_FILE_BYTES = 256 * 1024;
const LOGIN_LIFETIME_MS = 10 * 60_000;
const SafeRefSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const EnabledHarnessSchema = z.enum(["codex", "claude"]);
const ReceiptSchema = z.object({
  key: SafeRefSchema,
  payloadHash: z.string().length(64).regex(/^[a-f0-9]+$/),
  attempt: ProviderConnectionAttemptSchema,
}).strict();
const ReceiptDocumentSchema = z.object({
  version: z.literal(1),
  receipts: z.array(ReceiptSchema).max(MAX_RECEIPTS),
}).strict();

type LoginHarness = Parameters<ProviderLoginCoordinator["supportedMethods"]>[0];
type LoginInput = Parameters<ProviderLoginCoordinator["startLogin"]>[0];
type LoginRegistry = Pick<ShellRegistry, "create" | "get" | "delete">;
type ReceiptDocument = z.infer<typeof ReceiptDocumentSchema>;
type ReceiptWriter = (path: string, value: ReceiptDocument) => Promise<void>;

const LOGIN_COMMANDS = {
  codex: {
    agent: "codex" as const,
    command: "sh -lc 'export MATRIX_NODE_PREFIX=\"${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}\"; export PATH=\"$MATRIX_NODE_PREFIX/bin:$PATH\"; codex login --device-auth'",
  },
  claude: {
    agent: "claude" as const,
    command: "sh -lc 'export MATRIX_NODE_PREFIX=\"${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}\"; export PATH=\"$MATRIX_NODE_PREFIX/bin:$PATH\"; claude'",
  },
} as const;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isMissingSession(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as { code?: unknown }).code === "session_not_found";
}

async function readReceipts(path: string) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_FILE_BYTES) {
      throw new Error("Unsafe provider login receipt file");
    }
    return ReceiptDocumentSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissing(error)) return { version: 1 as const, receipts: [] };
    throw error;
  }
}

function payloadHash(input: LoginInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function loginSessionName(idempotencyKey: string): string {
  const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
  return `provider-login-${keyHash.slice(0, 24)}`;
}

function appendBoundedReceipt(document: ReceiptDocument, receipt: ReceiptDocument["receipts"][number]): void {
  document.receipts.push(receipt);
  if (document.receipts.length > MAX_RECEIPTS) {
    document.receipts.splice(0, document.receipts.length - MAX_RECEIPTS);
  }
}

function supportsHarness(
  enabledHarnesses: ReadonlySet<"codex" | "claude">,
  harness: LoginHarness,
): harness is LoginHarness & { harness: "codex" | "claude" } {
  return harness.installState === "installed"
    && (
      (harness.harness === "codex" && harness.driverId === "codex")
      || (harness.harness === "claude" && harness.driverId === "claude_code")
    )
    && enabledHarnesses.has(harness.harness);
}

export function createProviderTerminalLoginCoordinator(options: {
  homePath: string;
  registry: LoginRegistry;
  enabledHarnesses: readonly ("codex" | "claude")[];
  now?: () => Date;
  persistReceipt?: ReceiptWriter;
}): ProviderLoginCoordinator {
  if (!options.homePath) throw new Error("Provider login home path is required");
  if (!options.registry?.create || !options.registry.get || !options.registry.delete) {
    throw new Error("Provider login shell registry is required");
  }
  const enabledHarnesses = new Set(EnabledHarnessSchema.array().max(2).parse(options.enabledHarnesses));
  const receiptsPath = join(options.homePath, "system/ai-providers/login-receipts.json");
  const recoveryPath = join(options.homePath, "system/ai-providers/login-recovery.json");
  const now = options.now ?? (() => new Date());
  const persistReceipt = options.persistReceipt ?? writeProviderJsonAtomic;
  let tail: Promise<void> = Promise.resolve();

  async function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  return {
    supportedMethods(harness) {
      return supportsHarness(enabledHarnesses, harness)
        ? ["terminal"]
        : [];
    },

    async startLogin(input) {
      return await serialize(async () => {
        if (input.harness.id !== input.mutation.harnessInstanceId
          || input.mutation.method !== "terminal"
          || !supportsHarness(enabledHarnesses, input.harness)) {
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        const hash = payloadHash(input);
        const document = await readReceipts(receiptsPath);
        const recoveryDocument = await readReceipts(recoveryPath);
        const matchingReceipts = [...document.receipts, ...recoveryDocument.receipts]
          .filter((receipt) => receipt.key === input.mutation.idempotencyKey);
        if (new Set(matchingReceipts.map((receipt) => receipt.payloadHash)).size > 1) {
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        const duplicate = matchingReceipts[0];
        if (duplicate) {
          if (duplicate.payloadHash !== hash) {
            throw new ProviderSettingsStoreError("idempotency_conflict", 409);
          }
          const attempt = currentProviderConnectionAttempt(duplicate.attempt, now());
          if (attempt.state !== "expired" && attempt.action.kind === "open_terminal") {
            try {
              await options.registry.get(attempt.action.terminalSessionId);
            } catch (error) {
              if (!isMissingSession(error)) throw error;
              const command = LOGIN_COMMANDS[input.harness.harness];
              await options.registry.create({
                name: attempt.action.terminalSessionId,
                cwd: "~",
                cmd: command.command,
                agent: command.agent,
                exclusive: false,
              });
            }
          }
          return attempt;
        }

        const command = LOGIN_COMMANDS[input.harness.harness];
        const sessionName = loginSessionName(input.mutation.idempotencyKey);
        const attempt = ProviderConnectionAttemptSchema.parse({
          id: `attempt_${hash.slice(0, 24)}`,
          harnessInstanceId: input.mutation.harnessInstanceId,
          accountId: input.mutation.accountId,
          method: "terminal",
          state: "pending",
          action: { kind: "open_terminal", terminalSessionId: sessionName },
          expiresAt: new Date(now().getTime() + LOGIN_LIFETIME_MS).toISOString(),
          safeFailure: null,
        });
        const receipt = ReceiptSchema.parse({
          key: input.mutation.idempotencyKey,
          payloadHash: hash,
          attempt,
        });
        try {
          await options.registry.get(sessionName);
          try {
            await options.registry.delete(sessionName, { force: true });
          } catch (error) {
            console.warn(
              "[provider-login] Failed to reconcile unrecorded login session:",
              error instanceof Error ? error.name : "UnknownError",
            );
            throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
          }
        } catch (error) {
          if (!isMissingSession(error)) throw error;
        }
        appendBoundedReceipt(recoveryDocument, receipt);
        try {
          await writeProviderJsonAtomic(recoveryPath, ReceiptDocumentSchema.parse(recoveryDocument));
        } catch (error) {
          console.warn(
            "[provider-login] Failed to persist login recovery metadata:",
            error instanceof Error ? error.name : "UnknownError",
          );
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        const session = await options.registry.create({
          name: sessionName,
          cwd: "~",
          cmd: command.command,
          agent: command.agent,
          exclusive: false,
        });
        if (session.name !== sessionName) {
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        appendBoundedReceipt(document, receipt);
        try {
          await persistReceipt(receiptsPath, ReceiptDocumentSchema.parse(document));
        } catch (error) {
          try {
            await options.registry.delete(sessionName, { force: true });
          } catch (cleanupError) {
            console.warn(
              "[provider-login] Failed to clean up unrecorded login session:",
              cleanupError instanceof Error ? cleanupError.name : "UnknownError",
            );
          }
          console.warn(
            "[provider-login] Failed to persist login receipt:",
            error instanceof Error ? error.name : "UnknownError",
          );
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        return attempt;
      });
    },
  };
}
