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
const MAX_LEGACY_REVISION_LOOKBACK = 64;
const SafeRefSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const DigestSchema = z.string().length(64).regex(/^[a-f0-9]+$/);
const EnabledHarnessSchema = z.enum(["codex", "claude"]);
const ReceiptSchema = z.object({
  key: SafeRefSchema,
  payloadHash: DigestSchema,
  recoveryHash: DigestSchema.optional(),
  legacyPayloadHash: DigestSchema.optional(),
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

function recoveryIdentityHash(input: LoginInput): string {
  return createHash("sha256").update(JSON.stringify({
    providerId: input.harness.providerId,
    harness: input.harness.harness,
    driverId: input.harness.driverId,
    harnessInstanceId: input.mutation.harnessInstanceId,
    accountId: input.mutation.accountId,
    method: input.mutation.method,
  })).digest("hex");
}

function loginSessionName(recoveryHash: string): string {
  return `provider-login-${recoveryHash.slice(0, 24)}`;
}

interface RecoverySession {
  name: string;
  legacyPayloadHash?: string;
}

function exactRecoverySession(
  receipt: ReceiptDocument["receipts"][number],
  recoveryHash: string,
  input: LoginInput,
): RecoverySession | null {
  if (receipt.recoveryHash !== recoveryHash
    || receipt.attempt.harnessInstanceId !== input.mutation.harnessInstanceId
    || receipt.attempt.accountId !== input.mutation.accountId
    || receipt.attempt.method !== input.mutation.method
    || receipt.attempt.action.kind !== "open_terminal") {
    return null;
  }
  const sessionName = receipt.attempt.action.terminalSessionId;
  if (sessionName === loginSessionName(recoveryHash)) return { name: sessionName };
  if (input.harness.harness !== "codex" && input.harness.harness !== "claude") return null;
  const legacyPayloadHash = receipt.legacyPayloadHash ?? receipt.payloadHash;
  return sessionName === legacyLoginSessionName(input.harness.harness, legacyPayloadHash)
    ? { name: sessionName, legacyPayloadHash }
    : null;
}

function expiredRecoverySession(
  receipt: ReceiptDocument["receipts"][number],
  recoveryHash: string,
  input: LoginInput,
  currentTime: Date,
): RecoverySession | null {
  if (currentProviderConnectionAttempt(receipt.attempt, currentTime).state !== "expired") return null;
  return exactRecoverySession(receipt, recoveryHash, input);
}

function legacyLoginSessionName(harness: "codex" | "claude", legacyPayloadHash: string): string {
  return `provider-login-${harness}-${legacyPayloadHash.slice(0, 16)}`;
}

function matchesLegacyLoginPayload(
  input: LoginInput,
  receipt: ReceiptDocument["receipts"][number],
): boolean {
  if (receipt.recoveryHash !== undefined) return false;
  // Legacy receipts did not persist their recovery identity. Recompute the exact
  // legacy payload across a bounded revision window so unrelated provider, account,
  // harness, or method changes can never match while recovery work stays capped.
  const oldestRevision = Math.max(
    0,
    input.mutation.expectedRevision - MAX_LEGACY_REVISION_LOOKBACK,
  );
  for (let expectedRevision = input.mutation.expectedRevision;
    expectedRevision >= oldestRevision;
    expectedRevision -= 1) {
    if (payloadHash({
      ...input,
      mutation: {
        ...input.mutation,
        expectedRevision,
        idempotencyKey: receipt.key,
      },
    }) === receipt.payloadHash) {
      return true;
    }
  }
  return false;
}

function replaceBoundedReceipt(document: ReceiptDocument, receipt: ReceiptDocument["receipts"][number]): void {
  document.receipts = document.receipts.filter((candidate) => candidate.key !== receipt.key);
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
        const recoveryHash = recoveryIdentityHash(input);
        const document = await readReceipts(receiptsPath);
        const recoveryDocument = await readReceipts(recoveryPath);
        const currentTime = now();
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
          const attempt = currentProviderConnectionAttempt(duplicate.attempt, currentTime);
          const renewExpired = expiredRecoverySession(
            duplicate,
            recoveryHash,
            input,
            currentTime,
          ) !== null;
          if (!renewExpired && attempt.state !== "expired" && attempt.action.kind === "open_terminal") {
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
          if (!renewExpired) return attempt;
        }

        const liveLegacyReceipts = [];
        for (const receipt of document.receipts) {
          const attempt = currentProviderConnectionAttempt(receipt.attempt, currentTime);
          if (!matchesLegacyLoginPayload(input, receipt)
            || attempt.state === "expired"
            || attempt.action.kind !== "open_terminal"
            || attempt.action.terminalSessionId !== legacyLoginSessionName(
              input.harness.harness,
              receipt.payloadHash,
            )) {
            continue;
          }
          try {
            await options.registry.get(attempt.action.terminalSessionId);
            liveLegacyReceipts.push(receipt);
          } catch (error) {
            if (!isMissingSession(error)) throw error;
          }
        }
        if (liveLegacyReceipts.length > 1) {
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        const legacyReceipt = liveLegacyReceipts[0];
        if (legacyReceipt) {
          const legacyIndex = document.receipts.indexOf(legacyReceipt);
          document.receipts[legacyIndex] = ReceiptSchema.parse({
            ...legacyReceipt,
            recoveryHash,
            legacyPayloadHash: legacyReceipt.payloadHash,
          });
          try {
            await persistReceipt(receiptsPath, ReceiptDocumentSchema.parse(document));
          } catch (error) {
            console.warn(
              "[provider-login] Failed to upgrade legacy login receipt:",
              error instanceof Error ? error.name : "UnknownError",
            );
            throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
          }
        }

        const activeRecoveryReceipts = [...document.receipts, ...recoveryDocument.receipts].filter((receipt) =>
          receipt.recoveryHash === recoveryHash
          && currentProviderConnectionAttempt(receipt.attempt, currentTime).state !== "expired");
        const activeRecoveryAttempts = new Map<string, typeof activeRecoveryReceipts>();
        for (const receipt of activeRecoveryReceipts) {
          const key = JSON.stringify(receipt.attempt);
          activeRecoveryAttempts.set(key, [...(activeRecoveryAttempts.get(key) ?? []), receipt]);
        }
        if (activeRecoveryAttempts.size > 1) {
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        const recoverableReceipts = activeRecoveryAttempts.values().next().value;
        if (recoverableReceipts) {
          const recoverySessions = new Map<string, RecoverySession>();
          for (const candidate of recoverableReceipts) {
            const session = exactRecoverySession(candidate, recoveryHash, input);
            if (session) recoverySessions.set(JSON.stringify(session), session);
          }
          if (recoverySessions.size !== 1) {
            throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
          }
          const recoverySession = recoverySessions.values().next().value!;
          const recoverable = recoverableReceipts[0]!.attempt;
          const attempt = currentProviderConnectionAttempt(recoverable, now());
          if (attempt.action.kind !== "open_terminal") {
            throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
          }
          replaceBoundedReceipt(recoveryDocument, ReceiptSchema.parse({
            key: input.mutation.idempotencyKey,
            payloadHash: hash,
            recoveryHash,
            ...(recoverySession.legacyPayloadHash
              ? { legacyPayloadHash: recoverySession.legacyPayloadHash }
              : {}),
            attempt: recoverable,
          }));
          try {
            await writeProviderJsonAtomic(recoveryPath, ReceiptDocumentSchema.parse(recoveryDocument));
          } catch (error) {
            console.warn(
              "[provider-login] Failed to persist login recovery alias:",
              error instanceof Error ? error.name : "UnknownError",
            );
            throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
          }
          try {
            await options.registry.get(attempt.action.terminalSessionId);
          } catch (error) {
            if (!isMissingSession(error)) throw error;
            const recoveryCommand = LOGIN_COMMANDS[input.harness.harness];
            await options.registry.create({
              name: attempt.action.terminalSessionId,
              cwd: "~",
              cmd: recoveryCommand.command,
              agent: recoveryCommand.agent,
              exclusive: false,
            });
          }
          return attempt;
        }

        const expiredRecoverySessions = new Map<string, RecoverySession>();
        for (const candidate of [...document.receipts, ...recoveryDocument.receipts]) {
          const session = expiredRecoverySession(candidate, recoveryHash, input, currentTime);
          if (session) expiredRecoverySessions.set(JSON.stringify(session), session);
        }
        if (expiredRecoverySessions.size > 1) {
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        const expiredSession = expiredRecoverySessions.values().next().value;
        recoveryDocument.receipts = recoveryDocument.receipts.filter((receipt) =>
          receipt.recoveryHash !== recoveryHash);
        const command = LOGIN_COMMANDS[input.harness.harness];
        const canonicalSessionName = loginSessionName(recoveryHash);
        let sessionName = canonicalSessionName;
        let adoptedExpiredSession = false;
        if (expiredSession) {
          try {
            await options.registry.get(expiredSession.name);
            sessionName = expiredSession.name;
            adoptedExpiredSession = true;
          } catch (error) {
            if (!isMissingSession(error)) throw error;
          }
        }
        if (!adoptedExpiredSession) {
          try {
            await options.registry.get(canonicalSessionName);
            if (expiredSession?.name === canonicalSessionName) {
              adoptedExpiredSession = true;
            } else {
              try {
                await options.registry.delete(canonicalSessionName, { force: true });
              } catch (error) {
                console.warn(
                  "[provider-login] Failed to reconcile unrecorded login session:",
                  error instanceof Error ? error.name : "UnknownError",
                );
                throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
              }
            }
          } catch (error) {
            if (!isMissingSession(error)) throw error;
          }
        }
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
          recoveryHash,
          ...(expiredSession?.legacyPayloadHash
            ? { legacyPayloadHash: expiredSession.legacyPayloadHash }
            : {}),
          attempt,
        });
        replaceBoundedReceipt(recoveryDocument, receipt);
        try {
          await writeProviderJsonAtomic(recoveryPath, ReceiptDocumentSchema.parse(recoveryDocument));
        } catch (error) {
          console.warn(
            "[provider-login] Failed to persist login recovery metadata:",
            error instanceof Error ? error.name : "UnknownError",
          );
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        const session = adoptedExpiredSession
          ? { name: sessionName }
          : await options.registry.create({
            name: sessionName,
            cwd: "~",
            cmd: command.command,
            agent: command.agent,
            exclusive: false,
          });
        if (session.name !== sessionName) {
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        replaceBoundedReceipt(document, receipt);
        try {
          await persistReceipt(receiptsPath, ReceiptDocumentSchema.parse(document));
        } catch (error) {
          if (!adoptedExpiredSession) {
            try {
              await options.registry.delete(sessionName, { force: true });
            } catch (cleanupError) {
              console.warn(
                "[provider-login] Failed to clean up unrecorded login session:",
                cleanupError instanceof Error ? cleanupError.name : "UnknownError",
              );
            }
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
