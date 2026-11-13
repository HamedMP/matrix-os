import { isDeepStrictEqual } from "node:util";
import type { Transaction } from "kysely";
import type { RoutineCliVerifiedInvocation } from "../bots/routine-cli-source.js";
import { randomBytes } from "node:crypto";
import type { RoutineSourceProducer, RoutineSourcePolicy } from "../bots/routine-action-source-registry.js";
import type { ChatDatabase } from "./database.js";
import { hasNonPrivateChatScope } from "./private-routine-authority.js";
import { parseCanonicalProviderRunInput, type CanonicalProviderRunInput, type CanonicalProviderRunEvent } from "./provider-adapter.js";
import type { RoutineFullAccessSourceLease } from "../bots/routine-full-access.js";
/** Identity comes exclusively from the admitted execute closure. Native mode can narrow, never expand.
 * Full-access mode alone does not prove human provenance; only the host's private lease can raise its ceiling. */
export function createChatRoutineSourceProducer(options: { input: CanonicalProviderRunInput; computerId: string; signal: AbortSignal;
  publish(event: CanonicalProviderRunEvent): void; current(invocation?: RoutineCliVerifiedInvocation): boolean; provider?: "claude" | "codex" | "hermes" | "opencode" | "pi" | "matrix_pi";
  bindFullAccess?: (source: RoutineSourceProducer["source"], signal: AbortSignal) => RoutineFullAccessSourceLease | null }) {
  const input = parseCanonicalProviderRunInput(options.input), generation = `${options.provider === "matrix_pi" ? "managed" : "native"}_${randomBytes(24).toString("hex")}`;
  const provider = options.provider ?? "claude";
  if (provider !== "claude" && provider !== "codex" && provider !== "hermes" && provider !== "opencode" && provider !== "pi" && provider !== "matrix_pi") throw new Error("Routine source provider unavailable");
  const driver = provider === "claude" ? "claude_code" : provider;
  let narrowed = false;
  const policy: RoutineSourcePolicy = { live: true, scope: input.owner.type === "personal" && !input.sharedScopeId ? "personal" : input.owner.type === "organization" ? "org" : "shared",
    interactionMode: input.interactionMode === "default" ? "default" : input.interactionMode === "review" ? "review" : "plan",
    permissionMode: ["full_access", "supervised", "auto", "auto_accept_edits"].includes(input.permissionMode) ? input.permissionMode as RoutineSourcePolicy["permissionMode"] : "unsupported",
    originCeiling: "exact", revision: generation };
  const source: RoutineSourceProducer["source"] = { ownerId: input.owner.ownerId, computerId: options.computerId, harness: provider === "matrix_pi" ? "pi" : provider, identity: { kind: "chat_run", chatId: input.chatId, runId: input.runId, route: provider === "matrix_pi" ? "managed" : "native" },
    generation, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), actions: ["read", "propose", "control"] };
  let lease = provider === "claude" && policy.scope === "personal" && policy.permissionMode === "full_access"
    && policy.interactionMode === "default" ? options.bindFullAccess?.(source, options.signal) : null;
  const producer: RoutineSourceProducer = {
    source,
    signal: options.signal, publish: options.publish,
    readPolicy: () => ({ ...policy, originCeiling: lease ? "full" : "exact", revision: lease ? `${generation}:full_${lease.revision}` : generation,
      live: options.current() && !options.signal.aborted && (!lease || lease.current()),
      ...(narrowed ? { interactionMode: "plan" as const, originCeiling: "read" as const } : {}) }),
    async validateWithin(source, trx, action, invocation) {
      if (source.generation !== generation || !options.current(invocation) || options.signal.aborted || source.identity.kind !== "chat_run") return false;
      if (narrowed && action !== undefined && action !== "read") return false;
      // Hold current admission rows through issue/consume. Neither runtimeOwnerId nor model/native IDs supply scope.
      // Canonical Chat mutations acquire Chat before Run. Keep that order across this source boundary.
      const chat = await trx.selectFrom("chats").select("id").where("id", "=", input.chatId)
        .where("owner_id", "=", input.owner.ownerId).where("owner_type", "=", "personal")
        .where("lifecycle", "=", "active").where("collaboration", "is", null).forShare().executeTakeFirst();
      if (!chat) { await lease?.validateWithin(trx); return false; }
      if (narrowed && await hasNonPrivateChatScope(trx as unknown as Transaction<ChatDatabase>, input.owner, input.chatId)) return false;
      const row = await trx.selectFrom("chat_runs").select(["id", "instance_id", "selection"])
        .where("id", "=", input.runId).where("chat_id", "=", input.chatId).where("turn_id", "=", input.turnId)
        .where("driver_kind", "=", driver).where("permission_mode", "=", input.permissionMode)
        .where("interaction_mode", "=", input.interactionMode).where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"])
        .forShare().executeTakeFirst();
      const originLive = !lease || await lease.validateWithin(trx);
      return !!row && (provider !== "matrix_pi" || row.instance_id === input.selection.instanceId && isDeepStrictEqual(typeof row.selection === "string" ? JSON.parse(row.selection) : row.selection, input.selection))
        && originLive && options.current(invocation) && !options.signal.aborted;
    },
  };
  return { producer, fullAccessTarget: lease?.target, releaseFullAccess: () => lease?.release(),
    narrowNativeMode(mode?: string) {
      if (mode !== "plan" || narrowed) return;
      narrowed = true;
      // Only this deliberate downgrade can detach a live lease. A previously
      // revoked source stays fenced, and the registered target ceiling survives.
      const wasLive = lease?.current();
      lease?.release();
      if (wasLive) lease = null;
    } };
}
