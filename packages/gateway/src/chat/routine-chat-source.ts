import { randomBytes } from "node:crypto";
import type { RoutineSourceProducer, RoutineSourcePolicy } from "../bots/routine-action-source-registry.js";
import { parseCanonicalProviderRunInput, type CanonicalProviderRunInput, type CanonicalProviderRunEvent } from "./provider-adapter.js";
/** Identity comes exclusively from the admitted execute closure. Native mode can narrow, never expand.
 * Full-access mode does not prove parent/human provenance: all mutations require the exact owner decision. */
export function createChatRoutineSourceProducer(options: { input: CanonicalProviderRunInput; computerId: string; signal: AbortSignal;
  publish(event: CanonicalProviderRunEvent): void; current(): boolean; provider?: "claude" | "codex" }) {
  const input = parseCanonicalProviderRunInput(options.input), generation = `native_${randomBytes(24).toString("hex")}`;
  const provider = options.provider ?? "claude";
  if (provider !== "claude" && provider !== "codex") throw new Error("Routine source provider unavailable");
  const driver = provider === "codex" ? "codex" : "claude_code";
  let narrowed = false;
  const policy: RoutineSourcePolicy = { live: true, scope: input.owner.type === "personal" && !input.sharedScopeId ? "personal" : input.owner.type === "organization" ? "org" : "shared",
    interactionMode: input.interactionMode === "default" ? "default" : input.interactionMode === "review" ? "review" : "plan",
    permissionMode: ["full_access", "supervised", "auto", "auto_accept_edits"].includes(input.permissionMode) ? input.permissionMode as RoutineSourcePolicy["permissionMode"] : "unsupported",
    originCeiling: "exact", revision: generation };
  const producer: RoutineSourceProducer = {
    source: { ownerId: input.owner.ownerId, computerId: options.computerId, harness: provider, identity: { kind: "chat_run", chatId: input.chatId, runId: input.runId, route: "native" },
      generation, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), actions: ["read", "propose", "control"] },
    signal: options.signal, publish: options.publish,
    readPolicy: () => ({ ...policy, live: options.current() && !options.signal.aborted, ...(narrowed ? { interactionMode: "plan" as const, originCeiling: "read" as const } : {}) }),
    async validateWithin(source, trx) {
      if (source.generation !== generation || !options.current() || options.signal.aborted || source.identity.kind !== "chat_run") return false;
      // Hold current admission rows through issue/consume. Neither runtimeOwnerId nor model/native IDs supply scope.
      // Canonical Chat mutations acquire Chat before Run. Keep that order across this source boundary.
      const chat = await trx.selectFrom("chats").select("id").where("id", "=", input.chatId)
        .where("owner_id", "=", input.owner.ownerId).where("owner_type", "=", "personal")
        .where("lifecycle", "=", "active").where("collaboration", "is", null).forShare().executeTakeFirst();
      if (!chat) return false;
      const row = await trx.selectFrom("chat_runs").select("id")
        .where("id", "=", input.runId).where("chat_id", "=", input.chatId).where("turn_id", "=", input.turnId)
        .where("driver_kind", "=", driver).where("permission_mode", "=", input.permissionMode)
        .where("interaction_mode", "=", input.interactionMode).where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"])
        .forShare().executeTakeFirst();
      return !!row && options.current() && !options.signal.aborted;
    },
  };
  return { producer, narrowNativeMode(mode?: string) { if (mode === "plan") narrowed = true; } };
}
