import { createHash } from "node:crypto";
import { CanonicalChatExecutionRootRefSchema, CanonicalChatModelSelectionSchema, type BotToolCapability } from "@matrix-os/contracts";
import { SCOPE_RUNTIME_BOT_ADAPTER_ID, SCOPE_RUNTIME_BOT_HARNESS_VERSION, SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID } from "@matrix-os/scope-runtime/bot-profile";
import type { ScopeRuntimeHost } from "../scope-runtime-host/index.js";
import { BotAdmissionError } from "../bots/admission.js";
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from "../bots/runtime-registry.js";
import type { BotExecutor } from "../bots/repositories/shared.js";
import type { ResolvedBotRoute } from "../bots/route-resolver.js";
import type { ChatExecutionRootResolver } from "./execution-root.js";
import { managedPiWorkspace } from "./managed-pi-workspace.js";

export function createManagedPiAdmission(deps: {
  db: BotExecutor; homePath: string; host: ScopeRuntimeHost; registry: BotRuntimeRegistry;
  roots: Pick<ChatExecutionRootResolver, "resolve">;
}) {
  async function authority(input: { ownerId: string; chatId: string; runId: string }) {
    const row = await deps.db.selectFrom("chat_runs as run").innerJoin("chats as chat", "chat.id", "run.chat_id")
      .select(["run.selection", "run.execution_root", "run.execution_root_fingerprint", "run.permission_mode", "chat.project_id"])
      .where("run.id", "=", input.runId).where("chat.id", "=", input.chatId)
      .where("chat.owner_id", "=", input.ownerId).where("chat.owner_type", "=", "personal")
      .where("chat.collaboration", "is", null).where("chat.lifecycle", "=", "active")
      .where("run.driver_kind", "=", "matrix_pi").where("run.instance_id", "=", "matrix_pi_default")
      .where("run.status", "in", ["accepted", "running"])
      .where((eb) => eb.not(eb.exists(eb.selectFrom("bot_chat_bindings as binding").select("binding.chat_id")
        .whereRef("binding.chat_id", "=", "chat.id").where("binding.removed_at", "is", null))))
      .executeTakeFirst();
    if (!row) throw new BotAdmissionError("not_found");
    return row;
  }
  async function workspace(binding: Pick<ManagedPiRuntimeBinding, "ownerId" | "chatId" | "runId" | "workspace" | "rootFingerprint">): Promise<string> {
    await authority(binding);
    const root = "kind" in binding.workspace
      ? await managedPiWorkspace(deps.homePath, binding.ownerId, binding.chatId)
      : await deps.roots.resolve({ type: "personal", ownerId: binding.ownerId }, binding.workspace.ref)
        .then((root) => ({ path: root.primaryWorkspaceRoot, fingerprint: root.fingerprint }));
    if (root.fingerprint !== binding.rootFingerprint) throw new BotAdmissionError("root_changed");
    return root.path;
  }
  return {
    workspace,
    async admit(input: { ownerId: string; chatId: string; runId: string; resolved: ResolvedBotRoute }): Promise<ManagedPiRuntimeBinding> {
      if (!deps.host.available) throw new BotAdmissionError("unavailable");
      const row = await authority(input);
      const selection = CanonicalChatModelSelectionSchema.parse(typeof row.selection === "string" ? JSON.parse(row.selection) : row.selection);
      if (selection.model !== input.resolved.route.modelId || selection.instanceId !== "matrix_pi_default") throw new BotAdmissionError("not_found");
      let root: { path: string; fingerprint: string }; let workspaceRef: ManagedPiRuntimeBinding["workspace"];
      if (row.execution_root) {
        const ref = CanonicalChatExecutionRootRefSchema.parse(typeof row.execution_root === "string" ? JSON.parse(row.execution_root) : row.execution_root);
        if (ref.kind === "bot_workspace" || (row.project_id && ref.projectId !== row.project_id)) throw new BotAdmissionError("invalid_root");
        const resolved = await deps.roots.resolve({ type: "personal", ownerId: input.ownerId }, ref);
        if (resolved.fingerprint !== row.execution_root_fingerprint) throw new BotAdmissionError("root_changed");
        root = { path: resolved.primaryWorkspaceRoot, fingerprint: resolved.fingerprint };
        workspaceRef = { ref, fingerprint: root.fingerprint };
      } else {
        if (row.project_id) throw new BotAdmissionError("invalid_root");
        root = await managedPiWorkspace(deps.homePath, input.ownerId, input.chatId, true);
        workspaceRef = { kind: "chat_workspace" };
      }
      const capabilities: BotToolCapability[] = row.permission_mode === "full_access" ? ["artifact.read", "artifact.write"] : row.permission_mode === "supervised" ? ["artifact.read"] : [];
      if (!capabilities.length) throw new BotAdmissionError("not_found");
      const scopeHandle = `scope_${createHash("sha256").update(`managed-chat:${input.ownerId}:${input.chatId}`).digest("hex").slice(0, 32)}`;
      const runtime = await deps.host.client.createRuntime({ scopeHandle, profileId: SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID, workload: "bot_agent",
        adapterId: SCOPE_RUNTIME_BOT_ADAPTER_ID, harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION,
        sandbox: { version: 1, scopeHandle, actorId: input.ownerId, worktree: { hostPath: root.path, mode: row.permission_mode === "full_access" ? "rw" : "ro", fingerprint: root.fingerprint }, network: "broker_only" } });
      const binding: ManagedPiRuntimeBinding = { ...runtime, kind: "managed_chat", ownerId: input.ownerId, chatId: input.chatId,
        runId: input.runId, workspace: workspaceRef, rootFingerprint: root.fingerprint, route: input.resolved.route,
        accessSourceId: input.resolved.accessSourceId, capabilities, requestClass: "interactive" };
      try { deps.registry.bind(binding); }
      catch (error: unknown) { await deps.host.client.stopRuntime({ runtimeHandle: runtime.runtimeHandle }); throw error; }
      return binding;
    },
    async release(runtimeHandle: string): Promise<void> {
      deps.registry.release(runtimeHandle);
      await deps.host.client.stopRuntime({ runtimeHandle });
    },
  };
}
export type ManagedPiAdmission = ReturnType<typeof createManagedPiAdmission>;
