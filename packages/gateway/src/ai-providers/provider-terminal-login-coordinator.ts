import type { NativeProviderProfileGuard } from "./native-provider-profile-guard.js";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderConnectionAttemptSchema, TerminalRefSchema, type ProviderConnectionAttempt } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { recoverProviderLoginSession, type ProviderLoginRegistry } from "./provider-login-session-recovery.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";
import { MAX_PROVIDER_SETTINGS_RECEIPTS, writeProviderJsonAtomic } from "./provider-settings-persistence.js";
import type { ProviderLoginCoordinator } from "./provider-settings-coordinators.js";
import { currentProviderConnectionAttempt } from "./provider-settings-receipts.js";

// Login bindings must outlive the same successful mutations cached by Settings.
const MAX_RECEIPTS = MAX_PROVIDER_SETTINGS_RECEIPTS;
const MAX_FILE_BYTES = 1024 * 1024;
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
  superseded: z.literal(true).optional(),
  archivedSessionName: SafeRefSchema.optional(),
  attempt: ProviderConnectionAttemptSchema,
}).strict();
const ReceiptDocumentSchema = z.object({
  version: z.literal(1),
  receipts: z.array(ReceiptSchema).max(MAX_RECEIPTS),
}).strict();

type LoginHarness = Parameters<ProviderLoginCoordinator["supportedMethods"]>[0];
type LoginInput = Parameters<ProviderLoginCoordinator["startLogin"]>[0];
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
  // Base36 preserves all 256 digest bits while staying inside the shell's
  // lowercase 64-character session-name contract. Fixed-width padding keeps
  // the mapping bijective for digests with leading zeroes.
  const encoded = BigInt(`0x${recoveryHash}`).toString(36).padStart(50, "0");
  return `provider-auth-${encoded}`;
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
  receipt: Pick<ReceiptDocument["receipts"][number], "recoveryHash" | "key" | "payloadHash">,
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
  registry: ProviderLoginRegistry;
  enabledHarnesses: readonly ("codex" | "claude")[];
  profileGuard?: NativeProviderProfileGuard;
  now?: () => Date;
  persistReceipt?: ReceiptWriter;
}): ProviderLoginCoordinator & { resolveTerminalIdentity(attempt: ProviderConnectionAttempt): Promise<string> } {
  if (!options.homePath) throw new Error("Provider login home path is required");
  if (!options.registry?.create || !options.registry.get || !options.registry.delete
    || !options.registry.rename || !options.registry.observeAgentLiveness) {
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
    async resolveTerminalIdentity(attempt) {
      return await serialize(async () => {
        const validated = ProviderConnectionAttemptSchema.parse(attempt);
        if (validated.action.kind !== "open_terminal") throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        const identity = validated.action.terminalSessionId;
        const receipts = [...(await readReceipts(receiptsPath)).receipts, ...(await readReceipts(recoveryPath)).receipts]
          .filter(receipt => receipt.attempt.id === validated.id
            && receipt.attempt.harnessInstanceId === validated.harnessInstanceId
            && receipt.attempt.accountId === validated.accountId && receipt.attempt.method === validated.method
            && receipt.attempt.action.kind === "open_terminal" && receipt.attempt.action.terminalSessionId === identity);
        if (receipts.length === 0) throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        const retired = receipts.filter(receipt => receipt.superseded);
        let terminalIdentity = identity;
        if (retired.length > 0) {
          const archives = new Set(retired.map(receipt => receipt.archivedSessionName));
          if (archives.size !== 1 || archives.has(undefined)) throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
          terminalIdentity = [...archives][0]!;
        }
        if (!options.registry.resolveTerminalRef) throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        // Bind the outward action while the same coordinator lock prevents
        // another login from archiving and reusing this alias between awaits.
        const ref = TerminalRefSchema.parse(await options.registry.resolveTerminalRef(terminalIdentity));
        return `${ref.workspaceId}:${ref.tabId}`;
      });
    },
    supportedMethods(harness) {
      return supportsHarness(enabledHarnesses, harness)
        ? ["terminal"]
        : [];
    },

    async startLogin(input) {
      const start = () => serialize(async () => {
        if (input.harness.id !== input.mutation.harnessInstanceId
          || input.mutation.method !== "terminal"
          || !supportsHarness(enabledHarnesses, input.harness)) {
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        const hash = payloadHash(input);
        const recoveryHash = recoveryIdentityHash(input);
        const command = LOGIN_COMMANDS[input.harness.harness];
        const canonicalSessionName = loginSessionName(recoveryHash);
        const document = await readReceipts(receiptsPath);
        const recoveryDocument = await readReceipts(recoveryPath);
        const currentTime = now();
        const matchingReceipts = [...document.receipts, ...recoveryDocument.receipts]
          .filter((receipt) => receipt.key === input.mutation.idempotencyKey);
        if (new Set(matchingReceipts.map((receipt) => receipt.payloadHash)).size > 1) {
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        let duplicate = matchingReceipts.find(receipt => receipt.superseded) ?? matchingReceipts[0];
        if (duplicate) {
          if (duplicate.payloadHash !== hash) {
            throw new ProviderSettingsStoreError("idempotency_conflict", 409);
          }
          if (duplicate.superseded) return currentProviderConnectionAttempt(duplicate.attempt, currentTime);
          if (duplicate.attempt.action.kind === "open_terminal"
            && duplicate.attempt.action.terminalSessionId !== canonicalSessionName) {
            let canonicalSession: Awaited<ReturnType<ProviderLoginRegistry["get"]>> | null = null;
            try {
              canonicalSession = await options.registry.get(canonicalSessionName);
            } catch (error) {
              if (!isMissingSession(error)) throw error;
            }
            if (canonicalSession) {
              // A surviving canonical session means a prior migration crossed
              // the runtime/persistence boundary. Never recreate the legacy
              // name while that authoritative identity remains live.
              if (canonicalSession.name !== canonicalSessionName
                || await options.registry.observeAgentLiveness(
                  canonicalSessionName,
                  command.agent,
                ) !== "running") {
                throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
              }
              try {
                await options.registry.get(duplicate.attempt.action.terminalSessionId);
                throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
              } catch (error) {
                if (!isMissingSession(error)) throw error;
              }
              const repaired = ReceiptSchema.parse({
                ...duplicate,
                recoveryHash,
                legacyPayloadHash: duplicate.legacyPayloadHash ?? duplicate.payloadHash,
                attempt: {
                  ...duplicate.attempt,
                  action: { kind: "open_terminal", terminalSessionId: canonicalSessionName },
                },
              });
              const repairDocument = (candidate: ReceiptDocument) => {
                candidate.receipts = candidate.receipts.map((receipt) => (
                  receipt.key === duplicate!.key && receipt.payloadHash === duplicate!.payloadHash
                    ? repaired
                    : receipt
                ));
              };
              try {
                if (document.receipts.includes(duplicate)) {
                  repairDocument(document);
                  await persistReceipt(receiptsPath, ReceiptDocumentSchema.parse(document));
                }
                if (recoveryDocument.receipts.includes(duplicate)) {
                  repairDocument(recoveryDocument);
                  await writeProviderJsonAtomic(recoveryPath, ReceiptDocumentSchema.parse(recoveryDocument));
                }
              } catch (error) {
                console.warn(
                  "[provider-login] Failed to repair canonical login receipt:",
                  error instanceof Error ? error.name : "UnknownError",
                );
                throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
              }
              duplicate = repaired;
            }
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
          if (receipt.superseded || !matchesLegacyLoginPayload(input, receipt)
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
          if (legacyReceipt.attempt.action.kind !== "open_terminal") {
            throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
          }
          const legacySessionName = legacyReceipt.attempt.action.terminalSessionId;
          try {
            await options.registry.rename(legacySessionName, canonicalSessionName);
          } catch (error) {
            console.warn(
              "[provider-login] Failed to canonicalize legacy login session:",
              error instanceof Error ? error.name : "UnknownError",
            );
            throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
          }
          const legacyIndex = document.receipts.indexOf(legacyReceipt);
          document.receipts[legacyIndex] = ReceiptSchema.parse({
            ...legacyReceipt,
            recoveryHash,
            legacyPayloadHash: legacyReceipt.payloadHash,
            attempt: {
              ...legacyReceipt.attempt,
              action: { kind: "open_terminal", terminalSessionId: canonicalSessionName },
            },
          });
          try {
            await persistReceipt(receiptsPath, ReceiptDocumentSchema.parse(document));
          } catch (error) {
            try {
              await options.registry.rename(canonicalSessionName, legacySessionName);
            } catch (rollbackError) {
              console.warn(
                "[provider-login] Failed to roll back canonicalized login session:",
                rollbackError instanceof Error ? rollbackError.name : "UnknownError",
              );
            }
            console.warn(
              "[provider-login] Failed to upgrade legacy login receipt:",
              error instanceof Error ? error.name : "UnknownError",
            );
            throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
          }
        }

        const activeRecoveryReceipts = [...document.receipts, ...recoveryDocument.receipts].filter((receipt) =>
          !receipt.superseded && receipt.recoveryHash === recoveryHash
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
          const groupIdentity = JSON.stringify(recoverable);
          const isGroupReceipt = (receipt: ReceiptDocument["receipts"][number]) =>
            receipt.recoveryHash === recoveryHash && JSON.stringify(receipt.attempt) === groupIdentity;
          const plannedArchives = new Set([...document.receipts, ...recoveryDocument.receipts]
            .filter(receipt => isGroupReceipt(receipt) && receipt.archivedSessionName)
            .map(receipt => receipt.archivedSessionName!));
          if (plannedArchives.size > 1) throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
          const retireRecovery = async (archivedSessionName?: string) => {
            // Retired keys replay their immutable attempts only; they must never
            // resurrect a command while a fresh replacement is being recorded.
            const retire = (candidate: ReceiptDocument) => {
              candidate.receipts = candidate.receipts.map(receipt =>
                isGroupReceipt(receipt) && !receipt.superseded ? { ...receipt, superseded: true as const,
                  ...(archivedSessionName ? { archivedSessionName } : {}) } : receipt);
            };
            retire(document);
            retire(recoveryDocument);
            try {
              await persistReceipt(receiptsPath, ReceiptDocumentSchema.parse(document));
              await writeProviderJsonAtomic(recoveryPath, ReceiptDocumentSchema.parse(recoveryDocument));
            } catch (error) {
              console.warn("[provider-login] Failed to retire ended login receipts:", error instanceof Error ? error.name : "UnknownError");
              throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
            }
          };
          const existing = await recoverProviderLoginSession(options.registry, recoverySession.name, command.agent, hash,
            retireRecovery, [...plannedArchives][0]);
          const attempt = currentProviderConnectionAttempt(recoverable, now());
          if (existing === "live" && attempt.action.kind === "open_terminal") {
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
              console.warn("[provider-login] Failed to persist active login alias:", error instanceof Error ? error.name : "UnknownError");
              throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
            }
            return attempt;
          }
          if (existing !== "archived") await retireRecovery();
        }

        const expiredRecoverySessions = new Map<string, RecoverySession>();
        for (const candidate of [...document.receipts, ...recoveryDocument.receipts]) {
          const session = candidate.superseded ? null : expiredRecoverySession(candidate, recoveryHash, input, now());
          if (session) expiredRecoverySessions.set(JSON.stringify(session), session);
        }
        if (expiredRecoverySessions.size > 1) {
          throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
        }
        const expiredSession = expiredRecoverySessions.values().next().value;
        recoveryDocument.receipts = recoveryDocument.receipts.filter((receipt) =>
          receipt.recoveryHash !== recoveryHash);
        let sessionName = canonicalSessionName;
        let adoptedExpiredSession = false;
        if (expiredSession) {
          if (await recoverProviderLoginSession(options.registry, expiredSession.name, command.agent, hash) === "live") {
            sessionName = expiredSession.name;
            adoptedExpiredSession = true;
          }
        }
        if (!adoptedExpiredSession) {
          // The full-digest name preserves exact recovery even after bounded
          // receipts are evicted; unknown liveness never starts another login.
          adoptedExpiredSession = await recoverProviderLoginSession(
            options.registry, canonicalSessionName, command.agent, hash,
          ) === "live";
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
      if (options.profileGuard && (input.harness.harness === "codex" || input.harness.harness === "claude")) {
        // Preserve the historical conflict response before profile admission.
        // This is a read-only preflight; the serialized path rechecks receipts.
        const known = (await Promise.all([readReceipts(receiptsPath), readReceipts(recoveryPath)]))
          .flatMap(document => document.receipts).filter(receipt => receipt.key === input.mutation.idempotencyKey);
        if (known.some(receipt => receipt.payloadHash !== payloadHash(input))) {
          throw new ProviderSettingsStoreError("idempotency_conflict", 409);
        }
        return options.profileGuard.run(input.harness.harness, { kind: "login", recoveryKey: recoveryIdentityHash(input), matchesLegacyReceipt: (key, hash) => matchesLegacyLoginPayload(input, { key, payloadHash: hash }) }, start);
      }
      return start();
    },
  };
}
