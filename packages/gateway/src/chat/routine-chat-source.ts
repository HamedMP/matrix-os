import { isDeepStrictEqual } from "node:util";
import type { RoutineFullAccessSourceLease } from "../bots/routine-full-access-turn.js";
import type { RoutineCliVerifiedInvocation } from "../bots/routine-cli-source.js";
import { routineDirectChatSourceIsEligible } from "../bots/routine-direct-chat-contexts.js";
import { randomBytes } from "node:crypto";
import type { RoutineSourceProducer, RoutineSourcePolicy } from "../bots/routine-action-source-registry.js";
import { parseCanonicalProviderRunInput, type CanonicalProviderRunInput, type CanonicalProviderRunEvent } from "./provider-adapter.js";
/** Identity comes exclusively from the admitted execute closure. Native mode can narrow, never expand.
 * The host binds freshly admitted browser provenance separately from the selected mode. */
export function createChatRoutineSourceProducer(options: { input: CanonicalProviderRunInput; computerId: string; signal: AbortSignal;
  publish(event: CanonicalProviderRunEvent): void; current(invocation?: RoutineCliVerifiedInvocation): boolean; provider?: "claude" | "codex" | "hermes" | "opencode" | "pi" | "matrix_pi";
  lockRoutineDirectChatOrigin?: boolean;
  bindFullAccess?: (source: RoutineSourceProducer["source"]) => RoutineFullAccessSourceLease | null }) {
  const input = parseCanonicalProviderRunInput(options.input), generation = `${options.provider === "matrix_pi" ? "managed" : "native"}_${randomBytes(24).toString("hex")}`;
  const provider = options.provider ?? "claude";
  if (provider !== "claude" && provider !== "codex" && provider !== "hermes" && provider !== "opencode" && provider !== "pi" && provider !== "matrix_pi") throw new Error("Routine source provider unavailable");
  const driver = provider === "claude" ? "claude_code" : provider;
  // These admitted adapters offer the Matrix proposal tool without a native scheduler.
  // Claude owns native creation. Hermes can expose owner tools whose scheduling capability is unverified.
  const canPropose = !input.nativeScheduled && (provider === "codex" || provider === "opencode" || provider === "pi" || provider === "matrix_pi");
  const actions: RoutineSourceProducer["source"]["actions"] = canPropose ? ["read", "propose", "control"] : ["read", "control"];
  Object.freeze(actions);
  let narrowed = false;
  const policy: RoutineSourcePolicy = { live: true, scope: input.owner.type === "personal" && !input.sharedScopeId ? "personal" : input.owner.type === "organization" ? "org" : "shared",
    interactionMode: input.interactionMode === "default" ? "default" : input.interactionMode === "review" ? "review" : "plan",
    permissionMode: ["full_access", "supervised", "auto", "auto_accept_edits"].includes(input.permissionMode) ? input.permissionMode as RoutineSourcePolicy["permissionMode"] : "unsupported",
    originCeiling: "exact", revision: generation };
  const source: RoutineSourceProducer["source"] = {
    ownerId: input.owner.ownerId, computerId: options.computerId, harness: provider === "matrix_pi" ? "pi" : provider,
    identity: { kind: "chat_run", chatId: input.chatId, runId: input.runId, route: provider === "matrix_pi" ? "managed" : "native" },
    generation, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), actions,
  };
  const fullAccess = !input.nativeScheduled && policy.scope === "personal"
    && policy.interactionMode === "default" && policy.permissionMode === "full_access"
    ? options.bindFullAccess?.(source) : undefined;
  const producer: RoutineSourceProducer = {
    source,
    signal: options.signal, publish: options.publish,
    readPolicy: () => ({
      ...policy,
      live: options.current() && !options.signal.aborted,
      originCeiling: narrowed ? "read" : fullAccess?.current() ? "full" : "exact",
      interactionMode: narrowed ? "plan" : policy.interactionMode,
    }),
    async validateWithin(source, trx, action, invocation) {
      if (action && !actions.includes(action)) return false;
      if (source.generation !== generation || !options.current(invocation) || options.signal.aborted || source.identity.kind !== "chat_run") return false;
      if (narrowed && action !== undefined && action !== "read") return false;
      if (fullAccess && action !== "read" && !narrowed && !await fullAccess.validateWithin(trx)) return false;
      if (options.lockRoutineDirectChatOrigin && canPropose && action) {
        const eligible = await routineDirectChatSourceIsEligible(trx, { ownerId: input.owner.ownerId, sourceChatId: input.chatId }, { lock: true });
        if (!eligible && action === "propose") return false;
      }
      // Hold current admission rows through issue/consume. Neither runtimeOwnerId nor model/native IDs supply scope.
      // Canonical Chat mutations acquire Chat before Run. Keep that order across this source boundary.
      const chat = await trx.selectFrom("chats").select("id").where("id", "=", input.chatId)
        .where("owner_id", "=", input.owner.ownerId).where("owner_type", "=", "personal")
        .where("lifecycle", "=", "active").where("collaboration", "is", null).forShare().executeTakeFirst();
      if (!chat) return false;
      const row = await trx.selectFrom("chat_runs").select(["id", "instance_id", "selection"])
        .where("id", "=", input.runId).where("chat_id", "=", input.chatId).where("turn_id", "=", input.turnId)
        .where("driver_kind", "=", driver).where("permission_mode", "=", input.permissionMode)
        .where("interaction_mode", "=", input.interactionMode).where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"])
        .forShare().executeTakeFirst();
      return !!row && (provider !== "matrix_pi" || row.instance_id === input.selection.instanceId && isDeepStrictEqual(typeof row.selection === "string" ? JSON.parse(row.selection) : row.selection, input.selection)) && options.current(invocation) && !options.signal.aborted;
    },
  };
  return {
    producer, fullAccess,
    narrowNativeMode(mode?: string) {
      if (mode !== "plan") return;
      narrowed = true;
      fullAccess?.release();
    },
  };
}
