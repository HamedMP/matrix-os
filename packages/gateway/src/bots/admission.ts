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
import type { BotModelRoute, BotToolCapability } from "@matrix-os/contracts";
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
import { BotRuntimeRegistry, BotRuntimeRegistryError } from "./runtime-registry.js";

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

export interface PrivateBotRunRequest {
  ownerId: string;
  botId: string;
  chatId: string;
  taskId: string;
  runId: string;
  route: BotModelRoute;
  accessSourceId: BotCredentialAccessSourceId;
  subscription?: import("./chatgpt-plan.js").ChatGptPlanBinding;
  capabilities: readonly BotToolCapability[];
  requestClass: "interactive" | "background";
  /** The fingerprint stored with the task; a drift blocks the run as `root_changed`. */
  expectedRootFingerprint?: string;
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
}) {
  async function ownsDirectChat(input: { ownerId: string; botId: string; chatId: string }): Promise<boolean> {
    const row = await deps.db.selectFrom("bot_chat_bindings as binding")
      .innerJoin("chats as chat", "chat.id", "binding.chat_id")
      .select("binding.chat_id")
      .where("binding.owner_id", "=", input.ownerId).where("binding.bot_id", "=", input.botId)
      .where("binding.chat_id", "=", input.chatId).where("binding.kind", "=", "direct")
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
      if (!await ownsDirectChat(input)) throw new BotAdmissionError("not_found");
      let root: Awaited<ReturnType<typeof deps.roots.resolve>>;
      try {
        root = await deps.roots.resolve({ type: "personal", ownerId: input.ownerId }, { kind: "bot_workspace", botId: input.botId });
      } catch (error: unknown) {
        if (error instanceof ChatExecutionRootError) {
          throw new BotAdmissionError(error.code === "validation_unavailable" ? "unavailable" : "invalid_root");
        }
        throw error;
      }
      if (input.expectedRootFingerprint !== undefined && input.expectedRootFingerprint !== root.fingerprint) {
        throw new BotAdmissionError("root_changed");
      }
      const scopeHandle = privateBotScopeHandle(input.ownerId, input.botId);
      const manifest: ScopeRuntimeSandboxManifest = {
        version: 1,
        scopeHandle,
        actorId: input.botId,
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
          ...(input.subscription ? { subscription: input.subscription } : {}),
          capabilities: input.capabilities,
          requestClass: input.requestClass,
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
