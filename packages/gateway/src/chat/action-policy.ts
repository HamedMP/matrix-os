import type { CanonicalChatModelSelection, CanonicalChatRunPolicy, CanonicalProviderDriverKind } from "@matrix-os/contracts";
import { CanonicalExecutionPolicySchema, type CanonicalExecutionPolicy } from "@matrix-os/contracts";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import { canonicalJsonStringify } from "./argument-digest.js";
import { CanonicalActionError } from "./action-repository.js";
export interface ActionQualificationInput { driverKind: CanonicalProviderDriverKind; selection: CanonicalChatModelSelection; permissionMode: string; workspaceScope: string }
/** Caller flags never qualify a route. Only the loaded server adapter can attest its structural boundary. */
export async function revalidateActionPolicy(adapter: CanonicalChatProviderAdapter, input: Omit<ActionQualificationInput, "workspaceScope">, runPolicy?: CanonicalChatRunPolicy): Promise<void> {
  if (!runPolicy) return;
  if (runPolicy.memoryMode === "session_only") throw new CanonicalActionError();
  const frozen = runPolicy.executionPolicy;
  if (!frozen) {
    if (runPolicy.source === "voice" || runPolicy.voiceSessionId) throw new CanonicalActionError();
    return;
  }
  if (!adapter.qualifyPolicy) throw new CanonicalActionError();
  const actual = await adapter.qualifyPolicy({ ...input, workspaceScope: frozen.workspaceScope });
  const qualified = CanonicalExecutionPolicySchema.safeParse(actual);
  if (!qualified.success || canonicalJsonStringify(qualified.data) !== canonicalJsonStringify(frozen)) throw new CanonicalActionError();
  if (frozen.actionMode === "conversation_only" && frozen.tools.length) throw new CanonicalActionError();
  if (frozen.delegation) throw new CanonicalActionError(); // no independently qualified delegation path yet
}
export async function revalidateFrozenRunPolicy(adapter: CanonicalChatProviderAdapter, run: { chatId: string; driverKind: CanonicalProviderDriverKind; selection: CanonicalChatModelSelection; permissionMode: string; runPolicy?: CanonicalChatRunPolicy }, lookup?: import("./voice-session-policy.js").VoiceSessionPolicyLookup): Promise<void> {
  const live = lookup?.policyForChat(run.chatId);
  if (live && (live.memoryMode !== run.runPolicy?.memoryMode || live.permissionMode !== run.permissionMode || !live.executionPolicy || canonicalJsonStringify(live.executionPolicy) !== canonicalJsonStringify(run.runPolicy?.executionPolicy))) throw new CanonicalActionError();
  await revalidateActionPolicy(adapter, run, run.runPolicy);
}
export async function revalidateQueuedSteerPolicy(db: import("kysely").Kysely<import("./database.js").ChatDatabase>, chatId: string, queuedTurnId: string, runPolicy?: CanonicalChatRunPolicy): Promise<void> {
  const row = await db.selectFrom("chat_queued_turns").select("run_policy").where("id", "=", queuedTurnId).where("chat_id", "=", chatId).executeTakeFirst();
  if (!row) throw new CanonicalActionError();
  const queued = row.run_policy === null ? undefined : (await import("@matrix-os/contracts")).CanonicalChatRunPolicySchema.parse(row.run_policy);
  if (canonicalJsonStringify(queued?.executionPolicy) !== canonicalJsonStringify(runPolicy?.executionPolicy)) throw new CanonicalActionError();
}
export type { CanonicalExecutionPolicy };
