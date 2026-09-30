import type { CanonicalChatRunPolicy } from "@matrix-os/contracts";

/**
 * Minimal immutable fields canonical admission needs from a live voice
 * session that currently owns a Chat, plus the session id for provenance.
 * The engine supplies this through a registered provider; canonical code
 * treats the values as authoritative — a request cannot bypass a live
 * session's policy while it owns the Chat.
 */
export interface ActiveVoiceSessionPolicy {
  /** Live voice session id; stamped onto the run policy for provenance. */
  sessionId: string;
  memoryMode: "ordinary" | "session_only";
  permissionMode: string;
}

/**
 * Narrow read surface consumed by canonical admission paths (typed turns,
 * queued turns, and any admission producing a `chat_runs`/`chat_queued_turns`
 * row). Implementations are supplied by the voice-session engine.
 */
export interface VoiceSessionPolicyLookup {
  /** Live session policy for the Chat the session currently owns, if any. */
  policyForChat(chatId: string): ActiveVoiceSessionPolicy | undefined;
}

/**
 * Registration holder decoupling the voice-session engine from canonical
 * admission consumers. Bounded by construction — at most one provider is
 * registered at a time — and `clear` detaches only the identical provider so
 * a stale teardown cannot remove a replacement. The holder is composed
 * dependency-injected at startup; it never lives on `globalThis`.
 */
export function createVoiceSessionPolicyLookup(): {
  lookup: VoiceSessionPolicyLookup;
  set(provider: VoiceSessionPolicyLookup): void;
  clear(provider: VoiceSessionPolicyLookup): void;
} {
  let current: VoiceSessionPolicyLookup | undefined;
  return {
    lookup: {
      policyForChat(chatId) {
        return current?.policyForChat(chatId);
      },
    },
    set(provider) {
      current = provider;
    },
    clear(provider) {
      if (current === provider) current = undefined;
    },
  };
}

/**
 * Fold a live voice session's immutable policy into a pending admission.
 * While a session owns the Chat its memory/checkpoint mode and permission
 * mode are authoritative: an explicit request policy can narrow extras
 * (memory tool allowlists, retention class) but can never bypass the
 * session. The caller's `source` is preserved — spoken turns stay "voice",
 * typed turns stay "typed" — while `voiceSessionId` stamps the owning
 * session for provenance. Session-only structurally cannot carry memory
 * tools, so any requested allowlist is dropped rather than weakening the
 * schema invariant downstream.
 */
export function admissionPolicyForTurn(
  requested: { permissionMode: string; runPolicy?: CanonicalChatRunPolicy },
  session: ActiveVoiceSessionPolicy | undefined,
): { permissionMode: string; runPolicy?: CanonicalChatRunPolicy } {
  if (!session) return requested;
  const runPolicy: CanonicalChatRunPolicy = {
    ...requested.runPolicy,
    memoryMode: session.memoryMode,
    nativeCheckpointPolicy: session.memoryMode === "session_only" ? "disposable" : "reusable",
    source: requested.runPolicy?.source ?? "typed",
    voiceSessionId: session.sessionId,
  };
  // Session-only structurally forbids memory-capable tools.
  if (session.memoryMode === "session_only") delete runPolicy.memoryTools;
  return { permissionMode: session.permissionMode, runPolicy };
}
