// Spec 2710: adapts a teammate's shared terminal (over the direct
// collaboration stream to the owner's computer) to the socket contract the
// terminal view already speaks, so a team pane renders like any other.
// The owner's computer authorizes every frame; this only sends and shows.
import type { CollaborationDirectApi } from "@matrix-os/ui";
import type { ShellSocketEvents } from "../../../lib/shell-socket";
import type { SocketControl } from "../../terminal/attach-manager";
import { teamScopeFromSession } from "./team-terminals";
import { teamSession, updateTeamSession } from "./team-session-store";

/** Keystrokes typed within this window go out as one frame. */
const INPUT_FLUSH_MS = 16;
/** Characters per frame; well inside the 32 KiB input limit for any UTF-8 text. */
const INPUT_CHUNK_CHARS = 8_192;
const MAX_PENDING_CHARS = 256 * 1024;

function binaryToText(data: string): string {
  const bytes = Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff);
  return new TextDecoder().decode(bytes);
}

export function createTeamTerminalSocket(api: () => CollaborationDirectApi | null, sessionName: string, events: ShellSocketEvents): SocketControl {
  const scopeId = teamScopeFromSession(sessionName);
  let stop: (() => void) | null = null;
  let send: ((action: unknown) => boolean) | null = null;
  let ready: { connectionId: string; incarnation: string } | null = null;
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const viewer = () => teamSession(scopeId ?? "")?.projection?.role === "viewer";

  const flush = () => {
    timer = null;
    if (!send || !ready || !pending) return;
    while (pending) {
      const chunk = pending.slice(0, INPUT_CHUNK_CHARS);
      pending = pending.slice(chunk.length);
      const sent = send({ type: "input_shared", clientRequestId: crypto.randomUUID(), incarnation: ready.incarnation, connectionId: ready.connectionId, data: chunk });
      if (!sent) { pending = ""; return; }
    }
  };

  const queue = (data: string) => {
    if (disposed || !data || viewer()) return;
    // A stalled socket drops input rather than growing a backlog that would replay later.
    if (pending.length + data.length > MAX_PENDING_CHARS) return;
    pending += data;
    timer ??= setTimeout(flush, INPUT_FLUSH_MS);
  };

  const release = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = "";
    send = null;
    ready = null;
    stop?.();
    stop = null;
  };

  return {
    connect() {
      const client = api();
      if (!scopeId || !client || disposed) { events.onState("fatal"); return; }
      events.onState("connecting");
      const size = teamSession(scopeId)?.projection?.size;
      if (size) events.onCanonicalSize?.(size);
      events.onOwnershipChange?.(viewer() ? "observer" : "writer");
      stop = client.direct.subscribeTerminal(scopeId, {
        onReady: (frame) => {
          ready = { connectionId: frame.connectionId, incarnation: frame.incarnation };
          updateTeamSession(scopeId, { ended: false });
          events.onState("attached");
        },
        onOutput: (frame) => events.onOutput(frame.data, Number(frame.sequence)),
        onState: () => undefined,
        onRefreshRequired: () => events.onGap(),
        onUnavailable: () => {
          updateTeamSession(scopeId, { ended: true });
          events.onState("ended");
          release();
        },
        onDisconnected: () => {
          ready = null;
          events.onState("reconnecting");
        },
        onPresence: (frame) => updateTeamSession(scopeId, { presence: { inputMode: frame.inputMode, participants: frame.participants, marks: frame.marks } }),
        onInputRejected: (frame) => {
          updateTeamSession(scopeId, { rejected: { code: frame.code, at: Date.now() } });
          // A downgrade to Viewer: the pane stops offering input until it is reopened.
          if (frame.code === "forbidden") events.onOwnershipChange?.("observer");
        },
        onSender: (next) => { send = next; if (next) flush(); },
      });
    },
    sendInput: queue,
    sendBinary: (data) => queue(binaryToText(data)),
    // Only the owner sizes a shared terminal; collaborators render at its grid.
    resize: () => undefined,
    detach: release,
    dispose() {
      disposed = true;
      release();
    },
  };
}
