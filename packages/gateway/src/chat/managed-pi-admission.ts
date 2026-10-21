import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, CanonicalChatExecutionRootRefSchema, CanonicalChatModelSelectionSchema, type BotToolCapability } from "@matrix-os/contracts";
import { SCOPE_RUNTIME_BOT_ADAPTER_ID, SCOPE_RUNTIME_BOT_HARNESS_VERSION, SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID } from "@matrix-os/scope-runtime/bot-profile";
import type { ScopeRuntimeHost } from "../scope-runtime-host/index.js";
import { BotAdmissionError } from "../bots/admission.js";
import { BotRuntimeRegistry, isManagedPiBinding, type ManagedPiRuntimeBinding } from "../bots/runtime-registry.js";
import type { BotExecutor } from "../bots/repositories/shared.js";
import type { ResolvedBotRoute } from "../bots/route-resolver.js";
import type { ChatExecutionRootResolver } from "./execution-root.js";
import { resolveManagedPiPlan, resolveManagedPiAnthropic, sameManagedPiRoute } from "./managed-pi-route.js";
import { managedPiWorkspace } from "./managed-pi-workspace.js";

export function createManagedPiAdmission(deps: {
  db: BotExecutor; homePath: string; host: ScopeRuntimeHost; registry: BotRuntimeRegistry;
  chatgptPlan?: import("../bots/chatgpt-plan.js").ChatGptPlanAuthority;
  matrixAnthropic?: import("../bots/matrix-anthropic-api.js").MatrixAnthropicAuthority;
  toolCapabilities?: readonly BotToolCapability[];
  roots: Pick<ChatExecutionRootResolver, "resolve">;
}) {
  async function authority(input: { ownerId: string; chatId: string; runId: string }, allowPending = false) {
    const row = await deps.db.selectFrom("chat_runs as run").innerJoin("chats as chat", "chat.id", "run.chat_id")
      .select(["run.instance_id", "run.selection", "run.execution_root", "run.execution_root_fingerprint", "run.permission_mode", "chat.project_id"])
      .where("run.id", "=", input.runId).where("chat.id", "=", input.chatId)
      .where("chat.owner_id", "=", input.ownerId).where("chat.owner_type", "=", "personal")
      .where("chat.collaboration", "is", null).where("chat.lifecycle", "=", "active")
      .where("run.driver_kind", "=", "matrix_pi").where("run.instance_id", "in", ["matrix_pi_default", MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, "matrix_pi_anthropic_api"])
      .where("run.status", "in", allowPending ? ["accepted", "running", "waiting_for_approval"] : ["accepted", "running"])
      .where((eb) => eb.not(eb.exists(eb.selectFrom("bot_chat_bindings as binding").select("binding.chat_id")
        .whereRef("binding.chat_id", "=", "chat.id").where("binding.removed_at", "is", null))))
      .executeTakeFirst();
    if (!row) throw new BotAdmissionError("not_found");
    return row;
  }
  async function assertSource(row: Awaited<ReturnType<typeof authority>>, ownerId: string, resolved: ResolvedBotRoute) {
    const selection = CanonicalChatModelSelectionSchema.parse(typeof row.selection === "string" ? JSON.parse(row.selection) : row.selection);
    if (selection.instanceId !== row.instance_id || selection.model !== resolved.route.modelId) throw new BotAdmissionError("not_found");
    if (selection.instanceId === MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID) {
      const current = await resolveManagedPiPlan(selection, ownerId, deps.chatgptPlan);
      if (!sameManagedPiRoute(current, resolved)) throw new BotAdmissionError("not_found");
    } else if (selection.instanceId === "matrix_pi_anthropic_api") {
      const current = await resolveManagedPiAnthropic(selection, ownerId, deps.matrixAnthropic);
      if (!sameManagedPiRoute(current, resolved)) throw new BotAdmissionError("not_found");
    } else if (selection.instanceId !== "matrix_pi_default" || selection.options?.length
      || resolved.subscription || resolved.anthropicApi || resolved.accessSourceId !== "matrix_included" || resolved.route.api === "openai-responses") {
      throw new BotAdmissionError("not_found");
    }
  }
  async function workspace(binding: Pick<ManagedPiRuntimeBinding, "ownerId" | "chatId" | "runId" | "workspace" | "rootFingerprint" | "runtimeHandle" | "executionGeneration" | "route" | "accessSourceId" | "subscription" | "anthropicApi">): Promise<string> {
    const owned = deps.registry.lookupRun(binding);
    if (!owned || !isManagedPiBinding(owned) || owned.ownerId !== binding.ownerId || owned.chatId !== binding.chatId) throw new BotAdmissionError("not_found");
    const row = await authority(binding, true);
    if (!sameManagedPiRoute(owned, binding)) throw new BotAdmissionError("not_found");
    if (owned.rootFingerprint !== binding.rootFingerprint || !isDeepStrictEqual(owned.workspace, binding.workspace)) throw new BotAdmissionError("root_changed");
    if ("kind" in owned.workspace) {
      if (row.execution_root || row.execution_root_fingerprint || row.project_id) throw new BotAdmissionError("root_changed");
    } else {
      const ref = CanonicalChatExecutionRootRefSchema.parse(typeof row.execution_root === "string" ? JSON.parse(row.execution_root) : row.execution_root);
      if (ref.kind === "bot_workspace" || !isDeepStrictEqual(ref, owned.workspace.ref) || row.execution_root_fingerprint !== owned.rootFingerprint
        || owned.workspace.fingerprint !== owned.rootFingerprint || (row.project_id && row.project_id !== ref.projectId)) throw new BotAdmissionError("root_changed");
    }
    await assertSource(row, binding.ownerId, owned);
    const signal = deps.registry.inferenceSignal(owned);
    if (!signal || signal.aborted) throw new BotAdmissionError("not_found");
    const root = "kind" in owned.workspace
      ? await managedPiWorkspace(deps.homePath, binding.ownerId, binding.chatId)
      : await deps.roots.resolve({ type: "personal", ownerId: binding.ownerId }, owned.workspace.ref)
        .then((root) => ({ path: root.primaryWorkspaceRoot, fingerprint: root.fingerprint }));
    if (root.fingerprint !== binding.rootFingerprint) throw new BotAdmissionError("root_changed");
    // Root resolution awaits filesystem/project state. Native credential writes
    // can revoke the source during that wait without aborting the run signal.
    if (signal.aborted) throw new BotAdmissionError("not_found");
    await assertSource(row, binding.ownerId, owned);
    if (signal.aborted) throw new BotAdmissionError("not_found");
    return root.path;
  }
  return {
    workspace,
    async toolAuthority(binding: ManagedPiRuntimeBinding) {
      const owned = deps.registry.lookupRun(binding);
      if (!owned || owned.ownerId !== binding.ownerId || owned.chatId !== binding.chatId) throw new BotAdmissionError("not_found");
      const row = await authority(binding, true);
      await workspace(binding);
      return { permissionMode: row.permission_mode };
    },
    async admit(input: { ownerId: string; chatId: string; runId: string; resolved: ResolvedBotRoute }): Promise<ManagedPiRuntimeBinding> {
      if (!deps.host.available) throw new BotAdmissionError("unavailable");
      const row = await authority(input);
      await assertSource(row, input.ownerId, input.resolved);
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
      if (capabilities.length) capabilities.push(...(deps.toolCapabilities ?? []).filter(capability => row.permission_mode === "full_access" || capability !== "mcp.call"));
      if (!capabilities.length) throw new BotAdmissionError("not_found");
      const scopeHandle = `scope_${createHash("sha256").update(`managed-chat:${input.ownerId}:${input.chatId}`).digest("hex").slice(0, 32)}`;
      const runtime = await deps.host.client.createRuntime({ scopeHandle, profileId: SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID, workload: "bot_agent",
        adapterId: SCOPE_RUNTIME_BOT_ADAPTER_ID, harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION,
        sandbox: { version: 1, scopeHandle, actorId: input.ownerId, worktree: { hostPath: root.path, mode: row.permission_mode === "full_access" ? "rw" : "ro", fingerprint: root.fingerprint }, network: "broker_only" } });
      const binding: ManagedPiRuntimeBinding = { runtimeHandle: runtime.runtimeHandle, executionGeneration: runtime.executionGeneration,
        kind: "managed_chat", ownerId: input.ownerId, chatId: input.chatId,
        runId: input.runId, workspace: workspaceRef, rootFingerprint: root.fingerprint, route: input.resolved.route,
        accessSourceId: input.resolved.accessSourceId, ...(input.resolved.subscription ? { subscription: input.resolved.subscription } : {}), ...(input.resolved.anthropicApi ? { anthropicApi: input.resolved.anthropicApi } : {}), capabilities, requestClass: "interactive" };
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
