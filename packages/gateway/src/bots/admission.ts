/**
 * Private bot admission (spec 536, research R4). A private bot run needs no
 * collaboration scope: the owner principal must own the bot's live direct
 * chat, the bot's workspace must resolve (no links, fingerprinted), and the
 * run is launched under the bot profile with a manifest whose scope handle
 * is derived from the owner and bot. The runtime is then bound in the bot
 * registry, which the broker checks on every frame. Shared routes cannot
 * address a private handle: no collaboration scope uses this namespace.
 */
import { createHash } from "node:crypto";
import type { CanonicalChatExecutionRootRef, BotModelRoute, BotToolCapability } from "@matrix-os/contracts";
import {
  SCOPE_RUNTIME_BOT_ADAPTER_ID,
  SCOPE_RUNTIME_BOT_HARNESS_VERSION,
  SCOPE_RUNTIME_BOT_PROFILE_ID,
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
  capabilities: readonly BotToolCapability[];
  requestClass: "interactive" | "background";
  /** The fingerprint stored with the task; a drift blocks the run as `root_changed`. */
  expectedRootFingerprint?: string;
  group?: GroupBotRunRequest;
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
}) {
  async function ownsChat(input: { ownerId: string; botId: string; chatId: string; group?: GroupBotRunRequest }): Promise<boolean> {
    const row = await deps.db.selectFrom("bot_chat_bindings as binding")
      .innerJoin("chats as chat", "chat.id", "binding.chat_id")
      .select("binding.chat_id")
      .where("binding.owner_id", "=", input.ownerId).where("binding.bot_id", "=", input.botId)
      .where("binding.chat_id", "=", input.chatId).where("binding.kind", "=", input.group ? "group" : "direct")
      .where("binding.removed_at", "is", null)
      .where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", input.ownerId)
      .executeTakeFirst();
    return row !== undefined;
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

  return {
    /**
     * Launches a sandboxed bot runtime for one run. On any failure after the
     * runtime starts, it is stopped before the error is returned, so no
     * unbound runtime is left running.
     */
    async admit(input: PrivateBotRunRequest): Promise<AdmittedBotRuntime> {
      if (!deps.host.available) throw new BotAdmissionError("unavailable");
      if (!await ownsChat(input)) throw new BotAdmissionError("not_found");
      let group;
      if (input.group) {
        try {
          group = await requireGroupBotAuthority({ ownerId: input.ownerId, chatId: input.chatId, runId: input.runId, group: input.group }, deps.authorizeGroup);
        } catch (error: unknown) {
          console.warn("[bots] group admission denied:", error instanceof Error ? error.name : "UnknownError");
          throw new BotAdmissionError("not_found");
        }
        if (!/^[1-9][0-9]{0,18}$/.test(input.group.sessionGeneration)) throw new BotAdmissionError("not_found");
        if (!["project", "worktree"].includes(input.group.executionRoot.kind)) throw new BotAdmissionError("invalid_root");
        if (input.capabilities.some((capability) => !["integration.inventory", "integration.call"].includes(capability))) throw new BotAdmissionError("not_found");
      }
      let root: Awaited<ReturnType<typeof deps.roots.resolve>>;
      try {
        root = await deps.roots.resolve({ type: "personal", ownerId: input.ownerId }, input.group?.executionRoot ?? { kind: "bot_workspace", botId: input.botId });
      } catch (error: unknown) {
        if (error instanceof ChatExecutionRootError) {
          throw new BotAdmissionError(error.code === "validation_unavailable" ? "unavailable" : "invalid_root");
        }
        throw error;
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
      let runtime: { runtimeHandle: string; executionGeneration: string };
      try {
        runtime = await deps.host.client.createRuntime({
          scopeHandle,
          profileId: SCOPE_RUNTIME_BOT_PROFILE_ID,
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
        // Recheck after launch; membership can be revoked while runtime creation waits.
        if (group) await requireGroupBotAuthority({ ownerId: input.ownerId, chatId: input.chatId, runId: input.runId, group }, deps.authorizeGroup);
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
          capabilities: input.capabilities,
          requestClass: input.requestClass,
          ...(group ? { group } : {}),
        });
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
  };
}

export type PrivateBotAdmission = ReturnType<typeof createPrivateBotAdmission>;
