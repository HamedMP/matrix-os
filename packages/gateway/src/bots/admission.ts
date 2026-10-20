import { untilAborted } from "./broker-actions.js";
import type { CollaborationRevocationEnforcer, SandboxRuntimeRegistry } from "../collaboration/revocation-enforcer.js";
/**
 * Private bot admission (spec 536, research R4). A private bot run needs no
 * collaboration scope: the owner principal must own the bot's live direct
 * chat, the bot's workspace must resolve (no links, fingerprinted), and the
 * run is launched under the bot profile with a manifest whose scope handle
 * is derived from the owner and bot. The runtime is then bound in the bot
 * registry, which the broker checks on every frame. Shared routes cannot
 * address a private handle: no collaboration scope uses this namespace.
 */
import { lstat, realpath } from "node:fs/promises";
import { isAllowedSandboxRoot } from "../collaboration/shared-ai-runtime.js";
import { createHash } from "node:crypto";
import type { CanonicalChatExecutionRootRef, BotModelRoute, BotToolCapability } from "@matrix-os/contracts";
import {
  SCOPE_RUNTIME_BOT_ADAPTER_ID,
  SCOPE_RUNTIME_BOT_HARNESS_VERSION,
  SCOPE_RUNTIME_BOT_PROFILE_ID,
  SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID,
} from "@matrix-os/scope-runtime/bot-profile";
import type { ScopeRuntimeSandboxManifest } from "@matrix-os/scope-runtime";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import { ChatExecutionRootError } from "../chat/execution-root.js";
import type { BotCredentialAccessSourceId } from "./credentials.js";
import type { ScopeRuntimeHost } from "../scope-runtime-host/index.js";
import { ScopeRuntimeClientError } from "../collaboration/scope-runtime-client.js";
import type { BotExecutor } from "./repositories/shared.js";
import { requireGroupBotAuthority, type GroupBotAuthorizer, BotRuntimeRegistry, BotRuntimeRegistryError } from "./runtime-registry.js";

export type BotAdmissionErrorCode = "not_found" | "invalid_root" | "root_changed" | "unavailable" | "capacity_exceeded";

/** Allowlisted admission failures; callers map them to task blocked reasons. */
export class BotAdmissionError extends Error {
  constructor(readonly code: BotAdmissionErrorCode) {
    super(`Bot admission failed: ${code}`);
    this.name = "BotAdmissionError";
  }
}

/** `scope_` and the first 32 hex of sha256("bot-private:" + owner + ":" + bot). */
export function privateBotScopeHandle(ownerId: string, botId: string): string {
  return `scope_${createHash("sha256").update(`bot-private:${ownerId}:${botId}`).digest("hex").slice(0, 32)}`;
}

export interface GroupBotRevocation {
  runtimes: Pick<SandboxRuntimeRegistry, "bind" | "release">;
  revocations: Pick<CollaborationRevocationEnforcer, "isRevoked">;
}

export interface GroupBotRunRequest {
  scopeId: string;
  actorId: string;
  /** A root resolved from shared Chat authority, never the personal bot workspace. */
  executionRoot: Exclude<CanonicalChatExecutionRootRef, { kind: "bot_workspace" }>;
  executionRootFingerprint: string;
  sessionGeneration: string;
}

export interface PrivateBotRunRequest {
  ownerId: string;
  botId: string;
  chatId: string;
  taskId: string;
  runId: string;
  route: BotModelRoute;
  accessSourceId: BotCredentialAccessSourceId;
  managedDefinitionRevision?: number;
  recipeRef?: import("@matrix-os/contracts").BotRecipeRef;
  subscription?: import("./chatgpt-plan.js").ChatGptPlanBinding;
  anthropicApi?: import("@matrix-os/contracts").MatrixAnthropicBinding;
  capabilities: readonly BotToolCapability[];
  requestClass: "interactive" | "background";
  /** The fingerprint stored with the task; a drift blocks the run as `root_changed`. */
  expectedRootFingerprint?: string;
  group?: GroupBotRunRequest;
  /** Internal lifecycle fence; never supplied by a client payload. */
  signal?: AbortSignal;
}

export interface AdmittedBotRuntime {
  runtimeHandle: string;
  executionGeneration: string;
  rootFingerprint: string;
}

export function createPrivateBotAdmission(deps: {
  db: BotExecutor;
  host: Pick<ScopeRuntimeHost, "client" | "available">;
  roots: Pick<ChatExecutionRootResolver, "resolve">;
  registry: BotRuntimeRegistry;
  authorizeGroup?: GroupBotAuthorizer;
  getGroupRevocation?(): GroupBotRevocation | undefined;
  /** Trusted owner home; group mounts are restricted to its managed shared roots. */
  homePath?: string;
}) {
  async function ownsChat(input: { ownerId: string; botId: string; chatId: string; group?: GroupBotRunRequest }): Promise<boolean> {
    let query = deps.db.selectFrom("bot_chat_bindings as binding")
      .innerJoin("chats as chat", "chat.id", "binding.chat_id")
      .select("binding.chat_id")
      .where("binding.owner_id", "=", input.ownerId).where("binding.bot_id", "=", input.botId)
      .where("binding.chat_id", "=", input.chatId).where("binding.kind", "=", input.group ? "group" : "direct")
      .where("binding.removed_at", "is", null)
      .where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", input.ownerId)
      .where("chat.lifecycle", "=", "active");
    if (!input.group) query = query.where("chat.collaboration", "is", null);
    return await query.executeTakeFirst() !== undefined;
  }

  /** Unbinds first so no frame is authorized, then stops the workload. */
  async function release(runtimeHandle: string): Promise<void> {
    deps.registry.release(runtimeHandle);
    try {
      await deps.host.client.stopRuntime({ runtimeHandle });
    } catch (error: unknown) {
      if (!(error instanceof ScopeRuntimeClientError)) throw error;
      console.warn("[bots] bot runtime stop failed:", error.code);
    }
  }

  async function groupWait<T>(input: PrivateBotRunRequest, work: () => Promise<T>): Promise<T> {
    if (!input.group) return work();
    const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(input.signal ? [input.signal] : [])]);
    try {
      signal.throwIfAborted();
      const value = await untilAborted(work(), signal);
      signal.throwIfAborted();
      return value;
    } catch (error: unknown) {
      if (signal.aborted) throw new BotAdmissionError("unavailable");
      throw error;
    }
  }

  return {
    /**
     * Launches a sandboxed bot runtime for one run. On any failure after the
     * runtime starts, it is stopped before the error is returned, so no
     * unbound runtime is left running.
     */
    async admit(input: PrivateBotRunRequest): Promise<AdmittedBotRuntime> {
      if (!deps.host.available) throw new BotAdmissionError("unavailable");
      if (!await groupWait(input, () => ownsChat(input))) throw new BotAdmissionError("not_found");
      let group;
      let revocation: GroupBotRevocation | undefined;
      if (input.group) {
        revocation = deps.getGroupRevocation?.();
        if (!revocation) throw new BotAdmissionError("unavailable");
        if (revocation.revocations.isRevoked(input.group.scopeId, input.group.actorId)) throw new BotAdmissionError("not_found");
        if (!deps.authorizeGroup) throw new BotAdmissionError("unavailable");
        try {
          group = await groupWait(input, () => requireGroupBotAuthority({ ownerId: input.ownerId, chatId: input.chatId, runId: input.runId, group: input.group! }, deps.authorizeGroup));
        } catch (error: unknown) {
          if (error instanceof BotAdmissionError) throw error;
          console.warn("[bots] group admission denied:", error instanceof Error ? error.name : "UnknownError");
          throw new BotAdmissionError("not_found");
        }
        if (!/^[1-9][0-9]{0,18}$/.test(input.group.sessionGeneration)) throw new BotAdmissionError("not_found");
        if (!["project", "worktree"].includes(input.group.executionRoot.kind)) throw new BotAdmissionError("invalid_root");
        if (input.capabilities.some((capability) => !["integration.inventory", "integration.call"].includes(capability))) throw new BotAdmissionError("not_found");
      }
      let root: Awaited<ReturnType<typeof deps.roots.resolve>>;
      try {
        root = await groupWait(input, () => deps.roots.resolve({ type: "personal", ownerId: input.ownerId }, input.group?.executionRoot ?? { kind: "bot_workspace", botId: input.botId }));
      } catch (error: unknown) {
        if (error instanceof ChatExecutionRootError) {
          throw new BotAdmissionError(error.code === "validation_unavailable" ? "unavailable" : "invalid_root");
        }
        throw error;
      }
      if (input.group) {
        if (!deps.homePath) throw new BotAdmissionError("unavailable");
        try {
          const [home, candidate, stats] = await groupWait(input, () => Promise.all([realpath(deps.homePath!), realpath(root.primaryWorkspaceRoot), lstat(root.primaryWorkspaceRoot)]));
          if (!stats.isDirectory() || stats.isSymbolicLink() || candidate !== root.primaryWorkspaceRoot || !isAllowedSandboxRoot(home, candidate)) throw new BotAdmissionError("invalid_root");
        } catch (error: unknown) {
          if (error instanceof BotAdmissionError) throw error;
          throw new BotAdmissionError(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code)) ? "invalid_root" : "unavailable");
        }
      }
      if (input.group && (!/^[a-f0-9]{64}$/.test(input.group.executionRootFingerprint)
        || input.group.executionRootFingerprint !== root.fingerprint)) throw new BotAdmissionError("root_changed");
      if (input.expectedRootFingerprint !== undefined && input.expectedRootFingerprint !== root.fingerprint) {
        throw new BotAdmissionError("root_changed");
      }
      const scopeHandle = input.group
        ? `scope_${createHash("sha256").update(`bot-group:${input.ownerId}:${input.group.scopeId}:${input.chatId}:${input.botId}`).digest("hex").slice(0, 32)}`
        : privateBotScopeHandle(input.ownerId, input.botId);
      const manifest: ScopeRuntimeSandboxManifest = {
        version: 1,
        scopeHandle,
        actorId: input.group?.actorId ?? input.botId,
        worktree: { hostPath: root.primaryWorkspaceRoot, mode: "rw", fingerprint: root.fingerprint },
        network: "broker_only",
      };
      if (input.group && input.signal?.aborted) throw new BotAdmissionError("unavailable");
      let runtime: { runtimeHandle: string; executionGeneration: string };
      try {
        runtime = await deps.host.client.createRuntime({
          scopeHandle,
          // Shared roots use the independently pinned managed Pi mount policy.
          // Private recipes retain their bots-only profile and root restriction.
          profileId: group ? SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID : SCOPE_RUNTIME_BOT_PROFILE_ID,
          workload: "bot_agent",
          adapterId: SCOPE_RUNTIME_BOT_ADAPTER_ID,
          harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION,
          sandbox: manifest,
        });
      } catch (error: unknown) {
        if (error instanceof ScopeRuntimeClientError) throw new BotAdmissionError("unavailable");
        throw error;
      }
      try {
        // Provisioning awaits external work; authority may have changed since preflight.
        // Refuse publication and stop the new workload through the existing cleanup path.
        if (!await groupWait(input, () => ownsChat(input))) throw new BotAdmissionError("not_found");
        // Recheck after launch; membership can be revoked while runtime creation waits.
        if (group) await groupWait(input, () => requireGroupBotAuthority({ ownerId: input.ownerId, chatId: input.chatId, runId: input.runId, group: group! }, deps.authorizeGroup));
        if (group) {
          const current = deps.getGroupRevocation?.();
          if (!current || current.runtimes !== revocation?.runtimes || current.revocations !== revocation?.revocations) throw new BotAdmissionError("unavailable");
          if (current.revocations.isRevoked(group.scopeId, group.actorId)) throw new BotAdmissionError("not_found");
        }
        if (input.group && input.signal?.aborted) throw new BotAdmissionError("unavailable");
        // No await from the final revocation guard through both registry bindings.
        deps.registry.bind({
          runtimeHandle: runtime.runtimeHandle,
          executionGeneration: runtime.executionGeneration,
          ownerId: input.ownerId,
          botId: input.botId,
          chatId: input.chatId,
          taskId: input.taskId,
          runId: input.runId,
          rootFingerprint: root.fingerprint,
          route: input.route,
          accessSourceId: input.accessSourceId,
          ...(input.recipeRef ? { recipeRef: input.recipeRef } : {}),
          ...(input.managedDefinitionRevision !== undefined ? { managedDefinitionRevision: input.managedDefinitionRevision } : {}),
          ...(input.subscription ? { subscription: input.subscription } : {}),
          ...(input.anthropicApi ? { anthropicApi: input.anthropicApi } : {}),
          capabilities: input.capabilities,
          requestClass: input.requestClass,
          ...(group ? { group } : {}),
        }, group ? () => revocation!.runtimes.release(runtime.runtimeHandle) : undefined);
        if (group) revocation!.runtimes.bind({ scopeId: group.scopeId, actorId: group.actorId, runtimeHandle: runtime.runtimeHandle,
          onStop: () => deps.registry.release(runtime.runtimeHandle) });
      } catch (error: unknown) {
        await release(runtime.runtimeHandle);
        if (error instanceof BotRuntimeRegistryError && error.code === "capacity_exceeded") {
          throw new BotAdmissionError("capacity_exceeded");
        }
        throw error;
      }
      return { ...runtime, rootFingerprint: root.fingerprint };
    },
    release,
    ownsDirectChat: ({ ownerId, botId, chatId }: { ownerId: string; botId: string; chatId: string }) => ownsChat({ ownerId, botId, chatId }),
  };
}

export type PrivateBotAdmission = ReturnType<typeof createPrivateBotAdmission>;
