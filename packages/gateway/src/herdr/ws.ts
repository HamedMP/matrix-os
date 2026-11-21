// `/ws/terminal/herdr?id=`: a Herdr terminal attached in a Matrix terminal
// view. Frames match `/ws/terminal/tab`, so shell terminal components reuse
// their attach code. Viewers observe by default; only an exclusive lease types
// or resizes, so Matrix never fights the Herdr app over a terminal's size.
import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { z } from "zod/v4";
import { TerminalTabClientFrameSchema, type TerminalRef } from "@matrix-os/contracts";
import { HERDR_TERMINAL_WORKSPACE_ID, HerdrSessionIdSchema } from "@matrix-os/contracts/herdr-terminals";
import type { RequestPrincipal } from "../request-principal.js";
import { shellWsMessageDataToString } from "../shell/index.js";
import type { TerminalInputActivity } from "../terminal-agent/input-activity.js";
import type { TerminalLiveOwnership } from "../terminal-live-ownership.js";
import { HerdrAdapterError, type HerdrAdapter, type HerdrAttachment } from "./adapter.js";
import { herdrTerminalRef } from "./refs.js";
import { herdrOwnerAccess } from "./routes.js";

export const HERDR_TERMINAL_WS_PATH = "/ws/terminal/herdr";
const DEFAULT_MAX_VIEWERS_PER_SESSION = 8;
const DEFAULT_MAX_VIEWERS = 32;
// Clients ping every 10 s; a viewer silent this long lost its network.
const STALE_AFTER_MS = 60_000;
const SWEEP_MS = 15_000;
const MAX_OUTPUT_CHARS = 64 * 1024;
// Credit goes back to the core only while the socket keeps up, so a slow
// viewer slows its own stream instead of piling output up in memory.
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;
const DRAIN_POLL_MS = 25;
// How long a fresh attach waits for herdr-core's repaint before revealing the pane.
const FIRST_PAINT_WAIT_MS = 250;
const MAX_CLIENT_FRAME_CHARS = 128 * 1024;
// A reconnecting viewer's cursor below this resumes numbering there; larger
// values (Electron's live-tail sentinel is Number.MAX_SAFE_INTEGER) attach fresh.
const MAX_RESUME_SEQ = 2 ** 48;
// Full reset (RIS): a resumed viewer's old screen and scrollback give way to the core's repaint.
const SCREEN_RESET = "\x1bc";
// Retryable close for a lost herdr-core connection: the terminal may still be running.
const CONNECTION_LOST_CLOSE = 1012;

// A viewer names the terminal by herdr id, or by its Matrix terminal ref as the
// shell's terminal pane does for every tab.
const QuerySchema = z.object({
  id: HerdrSessionIdSchema.optional(),
  workspaceId: z.literal(HERDR_TERMINAL_WORKSPACE_ID).optional(),
  tabId: z.string().regex(/^tt_[0-9a-f]{32}$/).optional(),
  client: z.enum(["browser", "canvas", "desktop", "electron", "mobile", "cli", "hard"]).default("browser"),
  cols: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(20).max(500)).default(120),
  rows: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(5).max(200)).default(36),
  lease: z.enum(["exclusive", "observe"]).default("observe"),
  fromSeq: z.string().regex(/^\d{1,16}$/).transform(Number).optional(),
}).refine((query) => query.id !== undefined || (query.workspaceId !== undefined && query.tabId !== undefined));

interface Viewer {
  sessionId: string;
  lastTouched: number;
  close(code: number, reason: string): void;
}

function sameRef(a: TerminalRef, b: TerminalRef): boolean {
  return a.workspaceId === b.workspaceId && a.tabId === b.tabId;
}

export function registerHerdrTerminalWebSocket(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  adapter: HerdrAdapter | null;
  getPrincipal(context: Context): RequestPrincipal;
  terminalOwnerIds: readonly string[];
  terminalLiveOwnership: TerminalLiveOwnership;
  /** Records human keystrokes so automated sends wait for an unfinished draft. */
  terminalInputActivity?: TerminalInputActivity;
  maxViewersPerSession?: number;
  maxViewers?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const maxPerSession = options.maxViewersPerSession ?? DEFAULT_MAX_VIEWERS_PER_SESSION;
  const maxViewers = options.maxViewers ?? DEFAULT_MAX_VIEWERS;
  // Bounded by maxViewers; swept for stale viewers and drained on shutdown.
  const viewers = new Map<string, Viewer>();
  let draining = false;
  const sweep = setInterval(() => {
    for (const [viewerId, viewer] of viewers) {
      if (now() - viewer.lastTouched > STALE_AFTER_MS) {
        viewers.delete(viewerId);
        viewer.close(1001, "Terminal viewer idle");
      }
    }
  }, SWEEP_MS);
  sweep.unref();

  options.app.get(HERDR_TERMINAL_WS_PATH, options.upgradeWebSocket((c) => {
    const query = QuerySchema.safeParse({
      id: c.req.query("id"),
      workspaceId: c.req.query("workspaceId"),
      tabId: c.req.query("tabId"),
      client: c.req.query("client"),
      cols: c.req.query("cols"),
      rows: c.req.query("rows"),
      lease: c.req.query("lease"),
      fromSeq: c.req.query("fromSeq"),
    });
    const viewerId = randomUUID();
    let ref: TerminalRef | null = null;
    let sessionId: string | null = null;
    let ownershipKey: string | null = null;
    let attachment: HerdrAttachment | null = null;
    let attached = false;
    let closed = false;
    // The shell's terminal pane stays hidden until replay-end. herdr-core
    // repaints the screen right after an attach, so that first paint is the
    // replay; a short timer ends it when the paint comes late or not at all.
    let replaying = false;
    let replayTimer: ReturnType<typeof setTimeout> | null = null;
    let flushingPaint = false;
    // Each socket gets the core's full repaint. A viewer reconnecting with a
    // cursor keeps counting from it (clients drop output at or below the last
    // sequence they saw), and that repaint replaces what it already shows.
    const resumeFrom = query.success && query.data.fromSeq !== undefined && query.data.fromSeq > 0 && query.data.fromSeq <= MAX_RESUME_SEQ
      ? query.data.fromSeq
      : null;
    let seq = resumeFrom ?? 0;
    let resetPending = resumeFrom !== null;
    // Output that arrived while the attach was answered; sent after `attached`.
    const early: Array<{ data: string; consumed: () => void }> = [];
    const credits: Array<() => void> = [];
    let drainTimer: ReturnType<typeof setInterval> | null = null;
    let socket: WSContext | null = null;

    const backlog = () => {
      const raw = socket?.raw as { bufferedAmount?: unknown } | undefined;
      return typeof raw?.bufferedAmount === "number" ? raw.bufferedAmount : 0;
    };
    const send = (frame: unknown) => {
      if (closed || !socket) return;
      try { socket.send(JSON.stringify(frame)); }
      catch (error: unknown) { console.warn("[herdr] terminal viewer send failed", error instanceof Error ? error.name : "unknown_error"); }
    };
    const fail = (code: string, message: string, closeCode = 1008) => {
      send({ type: "error", code, message });
      closed = true;
      socket?.close(closeCode, message);
    };
    const drainCredits = () => {
      while (credits.length > 0 && backlog() <= LOW_WATER_BYTES) credits.shift()!();
      if (credits.length === 0 && drainTimer) { clearInterval(drainTimer); drainTimer = null; }
    };
    const endReplay = () => {
      if (replayTimer) clearTimeout(replayTimer);
      replayTimer = null;
      if (!replaying || closed || !ref) return;
      replaying = false;
      send({ type: "replay-end", terminalRef: ref, revision: 0, nextSeq: seq, toSeq: seq > 0 ? seq - 1 : null });
    };
    const output = (rawData: string, consumed: () => void) => {
      if (closed || !ref) return;
      const data = resetPending ? `${SCREEN_RESET}${rawData}` : rawData;
      resetPending = false;
      for (let offset = 0; offset < data.length; offset += MAX_OUTPUT_CHARS) {
        send({ type: "output", terminalRef: ref, revision: 0, seq: seq++, data: data.slice(offset, offset + MAX_OUTPUT_CHARS) });
      }
      if (replaying && !flushingPaint) endReplay();
      if (credits.length === 0 && backlog() <= HIGH_WATER_BYTES) { consumed(); return; }
      credits.push(consumed);
      drainTimer ??= setInterval(drainCredits, DRAIN_POLL_MS);
    };
    const release = () => {
      if (replayTimer) clearTimeout(replayTimer);
      replayTimer = null;
      viewers.delete(viewerId);
      if (drainTimer) clearInterval(drainTimer);
      drainTimer = null;
      credits.length = 0;
      early.length = 0;
      if (ownershipKey) options.terminalLiveOwnership.detach(ownershipKey, viewerId);
      ownershipKey = null;
      attachment?.detach();
      attachment = null;
    };

    return {
      onOpen(_event, ws) {
        socket = ws;
        if (!query.success) { fail("invalid_request", "Invalid request"); return; }
        if (draining) { fail("unavailable", "Terminal unavailable", 1001); return; }
        let principal: RequestPrincipal;
        try { principal = options.getPrincipal(c); }
        catch (error: unknown) {
          console.warn("[herdr] terminal viewer principal unavailable", error instanceof Error ? error.name : "unknown_error");
          fail("not_found", "Terminal unavailable");
          return;
        }
        const access = herdrOwnerAccess(principal, options.terminalOwnerIds);
        if (access !== "allowed") { fail(access === "unavailable" ? "unavailable" : "not_found", "Terminal unavailable"); return; }
        const adapter = options.adapter;
        if (!adapter) { fail("unavailable", "Terminal unavailable"); return; }
        const { cols, rows, lease } = query.data;
        const named = query.data;
        if (viewers.size >= maxViewers) { fail("capacity", "Too many viewers", 1013); return; }
        void (async () => {
          const listed = await adapter.list();
          const session = listed.sessions.find((candidate) => (named.id !== undefined ? candidate.id === named.id : candidate.tabId === named.tabId));
          if (!session) throw new HerdrAdapterError("not_found");
          if (closed) return;
          const id = session.id;
          sessionId = id;
          const sessionViewers = [...viewers.values()].filter((viewer) => viewer.sessionId === id).length;
          if (sessionViewers >= maxPerSession || viewers.size >= maxViewers) throw new HerdrAdapterError("capacity");
          viewers.set(viewerId, { sessionId: id, lastTouched: now(), close: (code, reason) => { closed = true; release(); ws.close(code, reason); } });
          ref = herdrTerminalRef(id);
          const terminalRef = ref;
          ownershipKey = `${principal.userId}:herdr:${id}`;
          const key = ownershipKey;
          options.terminalLiveOwnership.attach({
            key, viewerId, exclusive: lease === "exclusive", observe: lease !== "exclusive",
            onRevoked: (epoch) => send({ type: "lease-revoked", terminalRef, epoch }),
          });
          // Everyone but the writer attaches watch-only, so herdr-core never
          // lets a Matrix observer resize the program the owner's Herdr app is using.
          const writer = options.terminalLiveOwnership.role(key, viewerId) === "writer";
          const opened = await adapter.attach(id, { cols, rows }, {
            output: (data, consumed) => {
              if (attached) output(data, consumed);
              else early.push({ data, consumed });
            },
            closed: (reason) => {
              if (closed) return;
              // Only a terminal that really ended gets `exit`, which clients treat as final.
              if (reason === "exited") send({ type: "exit", terminalRef, revision: 0, exitCode: null });
              closed = true;
              release();
              if (reason === "exited") ws.close(1000, "Terminal ended");
              else ws.close(CONNECTION_LOST_CLOSE, "Terminal connection lost");
            },
          }, writer ? {} : { observe: true });
          if (closed) { opened.detach(); return; }
          attachment = opened;
          const role = options.terminalLiveOwnership.role(key, viewerId);
          const leaseEpoch = options.terminalLiveOwnership.leaseEpoch(key, viewerId);
          if (role === "writer") adapter.rememberSize(id, { cols, rows });
          send({
            type: "attached", terminalRef, revision: 0, canonicalSize: { cols, rows }, nextSeq: seq, ownership: role,
            capabilities: ["binary-input-v1"],
            ...(leaseEpoch === null ? {} : { leaseEpoch }),
          });
          send({ type: "replay-start", terminalRef, revision: 0, fromSeq: seq });
          replaying = true;
          attached = true;
          const paint = early.splice(0);
          if (paint.length > 0) {
            // Everything that arrived during the attach is the core's repaint.
            flushingPaint = true;
            for (const entry of paint) output(entry.data, entry.consumed);
            flushingPaint = false;
            endReplay();
          } else {
            replayTimer = setTimeout(endReplay, FIRST_PAINT_WAIT_MS);
          }
        })().catch((error: unknown) => {
          if (closed) return;
          if (error instanceof HerdrAdapterError) {
            if (error.code === "capacity") { fail("capacity", "Too many viewers", 1013); release(); return; }
            fail(error.code === "not_found" ? "not_found" : "unavailable", "Terminal unavailable");
            release();
            return;
          }
          console.warn("[herdr] terminal attach failed", error instanceof Error ? error.name : "unknown_error");
          fail("attach_failed", "Terminal attach failed");
          release();
        });
      },

      onMessage(event, ws) {
        const raw = shellWsMessageDataToString(event.data);
        if (raw === null || closed || !ref || !ownershipKey) return;
        let parsed: z.infer<typeof TerminalTabClientFrameSchema> | null = null;
        if (raw.length <= MAX_CLIENT_FRAME_CHARS) {
          try { parsed = TerminalTabClientFrameSchema.safeParse(JSON.parse(raw)).data ?? null; }
          catch (error: unknown) {
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
        if (!parsed || !sameRef(parsed.terminalRef, ref)) { fail("invalid_message", "Invalid message", 1003); release(); return; }
        const viewer = viewers.get(viewerId);
        if (viewer) viewer.lastTouched = now();
        options.terminalLiveOwnership.touch(ownershipKey, viewerId);
        const frame = parsed;
        switch (frame.type) {
          case "ping": send({ type: "pong", terminalRef: ref, revision: 0 }); return;
          case "detach": closed = true; release(); ws.close(1000, "Detached"); return;
          case "scroll-query": send({ type: "scroll-state", terminalRef: ref, revision: 0, state: null }); return;
          case "scroll-to": return;
          case "resize": {
            // Only the person who took control sets the size; observers never resize.
            if (attachment && options.terminalLiveOwnership.role(ownershipKey, viewerId) === "writer") {
              attachment.resize(frame.size.cols, frame.size.rows);
              if (sessionId) options.adapter?.rememberSize(sessionId, frame.size);
            }
            return;
          }
          case "input":
          case "binary": {
            if (!attachment || !options.terminalLiveOwnership.allowsMutation(ownershipKey, viewerId)) {
              send({ type: "error", code: "read_only", message: "Terminal is read-only" });
              return;
            }
            if (frame.type === "input") attachment.input(frame.data);
            else attachment.input(Buffer.from(frame.dataBase64, "base64").toString("latin1"), true);
            options.terminalInputActivity?.record(ref);
            return;
          }
        }
      },

      onClose() {
        closed = true;
        release();
      },
    };
  }));

  return {
    size: () => viewers.size,
    /** Closes every viewer before the adapter and its connection go away. */
    drain(): void {
      draining = true;
      clearInterval(sweep);
      for (const [viewerId, viewer] of [...viewers]) {
        viewers.delete(viewerId);
        viewer.close(1001, "Gateway shutting down");
      }
    },
  };
}
