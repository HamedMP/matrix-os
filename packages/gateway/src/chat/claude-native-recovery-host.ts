import { boundedOperation } from "../bounded-operation.js";
import type { ClaudeChatProviderAdapter } from "./claude-provider-adapter.js";
import type { ClaudeNativeRecoveryHost } from "./claude-native-chat-runtime.js";
import type { ClaudeNativeRecoveryInput } from "./claude-native-recovery-store.js";
import { buildClaudeNativeReplayJsonl } from "./claude-native-recovery-replay.js";
import type { CanonicalCliProcess } from "./cli-process.js";
import { ChatBusyError, ChatConflictError, ChatNotFoundError } from "./errors.js";
import { ChatExecutionRootError } from "./execution-root.js";
import { resolveNativeScheduledLaunch, type NativeScheduledAdmissionOptions } from "./native-scheduled-admission.js";
import type { ChatRepository } from "./repository.js";

type RecoveryAdapter = Pick<ClaudeChatProviderAdapter, "prepareNativeRecovery" | "stateSchemaVersion">;
type RecoveryLaunchPlan = NonNullable<Awaited<ReturnType<RecoveryAdapter["prepareNativeRecovery"]>>>;
type RecoveryLaunch = Pick<RecoveryLaunchPlan, "command" | "args" | "cwd" | "env"> & { transcript: Uint8Array };

/** Bridge the private recovery pool to the configured owner's canonical Chat and provider. */
export function createClaudeNativeRecoveryHost(options: Pick<NativeScheduledAdmissionOptions, "catalog" | "executionRoots"> & {
  ownerId: string;
  repository: Pick<ChatRepository, "getClaudeNativeRecoveryCheckpoint">;
  adapter: RecoveryAdapter;
  assertPersonalExecutionAllowed?: NativeScheduledAdmissionOptions["assertPersonalExecutionAllowed"];
  spawnProtected(input: RecoveryLaunch): CanonicalCliProcess;
}): ClaudeNativeRecoveryHost {
  async function resolve(checkpoint: ClaudeNativeRecoveryInput, signal: AbortSignal, includeHistory: boolean) {
    if (checkpoint.ownerId !== options.ownerId || signal.aborted || Date.parse(checkpoint.deadlineAt) <= Date.now()
      || !checkpoint.jobs.length || checkpoint.jobs.some(job => !job.recurring || !job.replay)) return null;
    const owner = { type: "personal" as const, ownerId: options.ownerId };
    const sourceIdentity = { sourceRunId: checkpoint.sourceRunId, sessionId: checkpoint.sessionId };
    const { assertPersonalExecutionAllowed } = options;
    try {
      if (assertPersonalExecutionAllowed) {
        await boundedOperation(() => assertPersonalExecutionAllowed(owner, checkpoint.chatId), 10_000, signal);
      }
      if (signal.aborted) return null;
      const source = await options.repository.getClaudeNativeRecoveryCheckpoint(owner, checkpoint.chatId, sourceIdentity, { includeHistory });
      if (signal.aborted || !source || source.adapterState.schemaVersion !== options.adapter.stateSchemaVersion) return null;
      const { root } = await boundedOperation(() => resolveNativeScheduledLaunch(options, owner, source), 10_000, signal);
      if (signal.aborted) return null;
      const launch = await options.adapter.prepareNativeRecovery({
        owner, run: source.run, state: source.adapterState.state, sessionId: checkpoint.sessionId,
        executionRoot: root?.primaryWorkspaceRoot, expectedSourceFingerprint: checkpoint.sourceFingerprint, signal,
      });
      if (signal.aborted || !launch || launch.sourceFingerprint !== checkpoint.sourceFingerprint
        || launch.sessionId !== checkpoint.sessionId) return null;
      // A new turn, provider switch or shared binding during preflight invalidates the captured history.
      const current = await options.repository.getClaudeNativeRecoveryCheckpoint(owner, checkpoint.chatId, sourceIdentity);
      return !signal.aborted && current?.chat.chat.revision === source.chat.chat.revision ? { launch, source } : null;
    } catch (error: unknown) {
      if (signal.aborted || error instanceof ChatConflictError || error instanceof ChatBusyError
        || error instanceof ChatNotFoundError || error instanceof ChatExecutionRootError
        || error instanceof Error && "code" in error && error.code === "shared_execution_disabled") return null;
      throw error;
    }
  }

  async function build(checkpoint: ClaudeNativeRecoveryInput, signal: AbortSignal) {
    const resolved = await resolve(checkpoint, signal, true);
    if (!resolved?.source.history || signal.aborted) return null;
    const { launch, source } = resolved;
    const transcript = buildClaudeNativeReplayJsonl({
      sessionId: checkpoint.sessionId, root: launch.cwd, nowMs: Date.now(),
      deadlineMs: Date.parse(checkpoint.deadlineAt), jobs: checkpoint.jobs, history: source.history,
    });
    return { launch, transcript };
  }

  return {
    async prepare(receipt, signal) {
      const prepared = await build(receipt, signal);
      if (!prepared || signal.aborted) return null;
      const { launch: { command, args, cwd, env, sourceFingerprint }, transcript } = prepared;
      return { sourceFingerprint, launchProtected() {
        signal.throwIfAborted();
        return options.spawnProtected({ command, args, cwd, env, transcript });
      } };
    },
    async revalidate(checkpoint, signal) {
      return !!await resolve(checkpoint, signal, false);
    },
    async checkpointAfterClose(checkpoint, signal) {
      return !!await build(checkpoint, signal);
    },
  };
}
