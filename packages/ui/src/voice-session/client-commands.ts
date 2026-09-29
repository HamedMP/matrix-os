/**
 * Routes `VoiceSessionController` commands to the transport and media layer.
 * The controller remains the only place commands are produced; this module is
 * the single sink that translates them into validated client frames and
 * capture/playout side effects.
 */
import type { VoiceSessionCommand } from "./controller.js";
import type { VoiceMediaSession } from "./media-session.js";
import type { VoiceTransport } from "./transport.js";

export interface VoiceCommandRouterDeps {
  media(): VoiceMediaSession | null;
  transport(): VoiceTransport | null;
  activeTurnId(): string | null;
  setActiveTurnId(turnId: string | null): void;
  makeId(prefix: "vturn_" | "req_"): string;
  /** Ends the session locally; `remoteEnded` skips the DELETE call. */
  teardown(remoteEnded: boolean): Promise<void>;
  /** `session.retry` performs an authenticated REST reconnect. */
  reconnect(): void;
  onContinueInChat(): void;
}

/**
 * Handles one controller command. `capture.stop`/`session.end` stop capture
 * before sending so the mic indicator drops immediately and no late chunk can
 * follow the terminal frame.
 */
export function routeVoiceCommand(deps: VoiceCommandRouterDeps, command: VoiceSessionCommand): void {
  switch (command.type) {
    case "capture.start": {
      const turnId = deps.makeId("vturn_");
      const media = deps.media();
      if (!media || !media.startCapture({ turnId })) return;
      deps.setActiveTurnId(turnId);
      deps.transport()?.send({ type: "capture.start", turnId, mode: command.mode });
      break;
    }
    case "capture.stop": {
      deps.media()?.stopCapture();
      const turnId = deps.activeTurnId();
      deps.setActiveTurnId(null);
      if (turnId !== null) deps.transport()?.send({ type: "capture.stop", turnId });
      break;
    }
    case "playback.segment_played":
      // Already validated by the controller's ack fencing; safe to forward.
      deps.transport()?.send(command);
      break;
    case "response.interrupt": {
      // The media boundary reflects what was actually heard; the controller's
      // value is only an acked-floor fallback.
      const played = deps.media()?.interruptResponse(command.responseId);
      deps.transport()?.send({
        type: "response.interrupt",
        responseId: command.responseId,
        playedThroughMs: played ?? command.playedThroughMs,
      });
      break;
    }
    case "session.pause":
      deps.transport()?.send({ type: "session.pause" });
      break;
    case "session.resume":
      deps.transport()?.send({ type: "session.resume" });
      break;
    case "session.end": {
      const turnId = deps.activeTurnId();
      if (turnId !== null) {
        deps.media()?.stopCapture();
        deps.setActiveTurnId(null);
        deps.transport()?.send({ type: "capture.stop", turnId });
      }
      deps.transport()?.send({ type: "session.end", reason: "user" });
      void deps.teardown(false);
      break;
    }
    case "session.retry":
      deps.reconnect();
      break;
    case "continue_in_chat":
      void deps.teardown(false);
      deps.onContinueInChat();
      break;
    default:
      break;
  }
}
