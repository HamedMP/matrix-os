import { randomUUID } from "node:crypto";
import type { CanonicalChatMessage, CanonicalChatRun } from "@matrix-os/contracts";
import { diagnoseChatRunFailure } from "./failure-diagnostic.js";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import type { ChatRepository, ClaimedQueuedTurn } from "./repository.js";
import type { ChatOwner } from "./records.js";

const MAX_SHARED_QUEUE_CLAIMS = 32;
const MAX_SHARED_DISPATCHES = 64;

type SharedExecutionRepository = Pick<ChatRepository,
  "claimNextQueuedTurn" | "finishRun" | "getAdapterState"
>;

export interface SharedActiveRunHandle {
  controller: AbortController;
  adapter: CanonicalChatProviderAdapter;
  owner: ChatOwner;
  chatId: string;
  runId: string;
  instanceId: string;
  sharedScopeId?: string;
}

export interface StartSharedDispatchInput {
  owner: ChatOwner;
  message: CanonicalChatMessage;
  run: CanonicalChatRun;
  adapter: CanonicalChatProviderAdapter;
  scopeId: string;
  onComplete: () => Promise<void>;
}

export interface SharedChatExecutionCoordinatorOptions {
  repository: SharedExecutionRepository;
  isClosing(): boolean;
  atCapacity(owner: ChatOwner): boolean;
  hasActiveRun(owner: ChatOwner, chatId: string): boolean;
  getActiveRun(runId: string): SharedActiveRunHandle | undefined;
  startDispatch(input: StartSharedDispatchInput): void;
  onSharedEvent?: (scopeId: string) => Promise<void>;
  runUnavailableError?: () => Error;
  now?: () => Date;
}

export class SharedChatRunPreparationError extends Error {
  constructor(readonly requestState: "unauthorized" | "unavailable") {
    super("Shared Chat execution preparation failed");
    this.name = "SharedChatRunPreparationError";
  }
}

export class SharedChatExecutionCoordinator {
  private readonly queueDispatches = new Set<string>();

  constructor(private readonly options: SharedChatExecutionCoordinatorOptions) {}

  async dispatchNextQueued(
    owner: ChatOwner,
    chatId: string,
    scopeId: string,
    createAdapter: (
      context: NonNullable<ClaimedQueuedTurn["sharedExecution"]>,
    ) => Promise<CanonicalChatProviderAdapter> | CanonicalChatProviderAdapter,
  ): Promise<void> {
    if (this.options.isClosing() || this.options.atCapacity(owner)
      || this.options.hasActiveRun(owner, chatId)) return;

    const key = `${scopeId}:${chatId}`;
    if (this.queueDispatches.has(key) || this.queueDispatches.size >= MAX_SHARED_DISPATCHES) return;
    this.queueDispatches.add(key);
    try {
      for (let offset = 0; offset < MAX_SHARED_QUEUE_CLAIMS
        && !this.options.isClosing() && !this.options.atCapacity(owner); offset += 1) {
        const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
        const claimed = await this.options.repository.claimNextQueuedTurn(owner, {
          chatId,
          collaborationScopeId: scopeId,
          turnId: identifier("cturn_"),
          runId: identifier("run_"),
          messageId: identifier("msg_"),
          claimedAt: timestamp,
        });
        if (!claimed) {
          await this.notify(scopeId);
          return;
        }
        if (!claimed.sharedExecution || claimed.sharedExecution.scopeId !== scopeId
          || claimed.run.executionRoot) {
          await this.finishPreparationFailure(
            owner,
            chatId,
            claimed.run.id,
            timestamp,
            "interrupted",
            { stage: "preparation", category: "authorization" },
          );
          await this.notify(scopeId);
          continue;
        }

        let adapter: CanonicalChatProviderAdapter;
        try {
          adapter = await createAdapter(claimed.sharedExecution);
          if (adapter.driverKind !== claimed.run.driverKind) {
            throw new Error("Shared adapter driver mismatch");
          }
        } catch (error: unknown) {
          console.warn(
            "[chat/shared-execution] Shared Run preparation failed:",
            error instanceof Error ? error.name : "UnknownError",
          );
          await this.finishPreparationFailure(
            owner,
            chatId,
            claimed.run.id,
            timestamp,
            error instanceof SharedChatRunPreparationError ? error.requestState : "interrupted",
            diagnoseChatRunFailure(error, "preparation"),
          );
          await this.notify(scopeId);
          continue;
        }

        this.options.startDispatch({
          owner,
          message: claimed.message,
          run: claimed.run,
          adapter,
          scopeId,
          onComplete: () => this.dispatchNextQueued(owner, chatId, scopeId, createAdapter),
        });
        return;
      }
    } finally {
      this.queueDispatches.delete(key);
    }
  }

  async cancel(owner: ChatOwner, scopeId: string, chatId: string, runId: string): Promise<void> {
    const active = this.options.getActiveRun(runId);
    if (!active || active.sharedScopeId !== scopeId || active.chatId !== chatId
      || active.owner.type !== owner.type || active.owner.ownerId !== owner.ownerId) {
      throw this.options.runUnavailableError?.() ?? new Error("Shared Run unavailable");
    }

    active.controller.abort();
    const state = await this.options.repository.getAdapterState(owner, {
      runId,
      driverKind: active.adapter.driverKind,
      instanceId: active.instanceId,
    });
    await active.adapter.cancel?.({
      owner,
      chatId,
      runId,
      ...(state ? { state: active.adapter.parseState(state.state) } : {}),
    });
    await this.options.repository.finishRun(owner, {
      chatId,
      runId,
      outcome: "aborted",
      completedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
    await this.notify(scopeId);
  }

  async notify(scopeId: string | undefined): Promise<void> {
    if (!scopeId || !this.options.onSharedEvent) return;
    try {
      await this.options.onSharedEvent(scopeId);
    } catch (error: unknown) {
      console.warn(
        "[chat/shared-execution] Shared event delivery failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }

  private async finishPreparationFailure(
    owner: ChatOwner,
    chatId: string,
    runId: string,
    completedAt: string,
    sharedRequestState: "unauthorized" | "unavailable" | "interrupted",
    diagnostic: ReturnType<typeof diagnoseChatRunFailure>,
  ): Promise<void> {
    await this.options.repository.finishRun(owner, {
      chatId,
      runId,
      outcome: "failed",
      sharedRequestState,
      completedAt,
      diagnostic,
    });
  }
}

function identifier(prefix: "cturn_" | "run_" | "msg_"): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}
