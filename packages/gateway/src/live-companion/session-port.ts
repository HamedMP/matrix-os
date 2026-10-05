import type { LiveCompanionPort } from "./coordinator.js";
import type { VoiceSessionHost, VoiceSessionRecord } from "../voice-session/session-runtime.js";
/** Bind history and ordinary delegated Chat admission to the captured principal. */
export function sessionLivePort(session: VoiceSessionRecord, host: VoiceSessionHost): LiveCompanionPort | undefined {
  return host.liveHistory?.({ principalId: session.principalId, chatId: session.chatId, principalSource: session.principalSource, selection: session.selection });
}
