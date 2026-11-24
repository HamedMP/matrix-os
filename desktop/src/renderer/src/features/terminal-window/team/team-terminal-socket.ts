// Spec 2710: adapts a teammate's shared terminal (over the direct
// collaboration stream to the owner's computer) to the socket contract the
// terminal view already speaks, so a team pane renders like any other.
// The owner's computer authorizes every frame; this only sends and shows.
import type { CollaborationDirectApi } from "@matrix-os/ui";
import type { ShellSocketEvents } from "../../../lib/shell-socket";
import type { SocketControl } from "../../terminal/attach-manager";
import { teamScopeFromSession } from "./team-terminals";
import { subscribeTeamSessions, teamSession, updateTeamSession } from "./team-session-store";

/** Keystrokes typed within this window go out as one frame. */
const INPUT_FLUSH_MS = 16;
/** Characters per frame; well inside the 32 KiB input limit for any UTF-8 text. */
const INPUT_CHUNK_CHARS = 8_192;
const MAX_PENDING_CHARS = 256 * 1024;
/** Below the owner's per-socket budget (64 KiB/s), so a long paste arrives whole, a second at a time. */
const BYTES_PER_SECOND = 56 * 1024;

function binaryToText(data: string): string {
  const bytes = Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff);
  return new TextDecoder().decode(bytes);
}

/** A frame's end, never between the halves of one character. */
function safeEnd(value: string, end: number): number {
  if (end >= value.length) return value.length;
  const last = value.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

export function createTeamTerminalSocket(api: () => CollaborationDirectApi | null, sessionName: string, events: ShellSocketEvents): SocketControl {
  const scopeId = teamScopeFromSession(sessionName);
  const encoder = new TextEncoder();
  let stop: (() => void) | null = null;
  let stopSize: (() => void) | null = null;
  let send: ((action: unknown) => boolean) | null = null;
  let ready: { connectionId: string; incarnation: string } | null = null;
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let window = { start: 0, bytes: 0 };
  let size: { cols: number; rows: number } | undefined;

  const viewer = () => teamSession(scopeId ?? "")?.projection?.role === "viewer";

  const schedule = (delay: number) => { timer ??= setTimeout(flush, delay); };

  function flush(): void {
    timer = null;
    if (!send || !ready || !pending) return;
    while (pending) {
      const now = Date.now();
      if (now - window.start >= 1_000) window = { start: now, bytes: 0 };
      const end = safeEnd(pending, Math.min(INPUT_CHUNK_CHARS, pending.length));
      const chunk = pending.slice(0, end || Math.min(2, pending.length));
      const bytes = encoder.encode(chunk).byteLength;
      if (window.bytes > 0 && window.bytes + bytes > BYTES_PER_SECOND) {
        // Paced: the rest goes when the owner's budget allows it.
        schedule(1_000 - (now - window.start));
        return;
      }
      pending = pending.slice(chunk.length);
      window.bytes += bytes;
      const sent = send({ type: "input_shared", clientRequestId: crypto.randomUUID(), incarnation: ready.incarnation, connectionId: ready.connectionId, data: chunk });
      if (!sent) { pending = ""; return; }
    }
  }

  const queue = (data: string) => {
    if (disposed || !data || viewer()) return;
    // A stalled socket drops input rather than growing a backlog that would replay later.
    if (pending.length + data.length > MAX_PENDING_CHARS) return;
    pending += data;
    schedule(INPUT_FLUSH_MS);
  };

  /** The owner resizes; every open pane follows the grid the list refresh brings. */
  const followSize = () => {
    const next = teamSession(scopeId ?? "")?.projection?.size;
    if (!next || (size && size.cols === next.cols && size.rows === next.rows)) return;
    size = next;
    events.onCanonicalSize?.(next);
  };

  const release = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = "";
    send = null;
    ready = null;
    stopSize?.();
    stopSize = null;
    stop?.();
    stop = null;
  };

  return {
    connect() {
      const client = api();
      if (!scopeId || !client || disposed) { events.onState("fatal"); return; }
      events.onState("connecting");
      followSize();
      stopSize = subscribeTeamSessions(followSize);
      // A Viewer's read-only state is shown by the pane header ("View only"); keystrokes are dropped
      // here and refused by the owner's computer. The device-ownership banner does not apply.
      events.onOwnershipChange?.("writer");
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
          // A downgrade to Viewer: input stops here too until the pane is reopened.
          const projection = teamSession(scopeId)?.projection;
          updateTeamSession(scopeId, {
            rejected: { code: frame.code, at: Date.now() },
            ...(frame.code === "forbidden" && projection ? { projection: { ...projection, role: "viewer" } } : {}),
          });
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
