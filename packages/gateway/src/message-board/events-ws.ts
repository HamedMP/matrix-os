import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { BoardSocketClientFrameSchema, BoardSocketQuerySchema, type BoardSocketFrame } from "@matrix-os/contracts/message-board";
import { MessageBoardServiceError } from "./errors.js";
import { readBoardEvents, type BoardEventHub, type BoardSubscriptionHandle } from "./events.js";
import type { BoardCaller, MessageBoardService } from "./service.js";

export const BOARD_EVENTS_WS_PATH = "/ws/board/events";
const MAX_CLIENT_FRAME_CHARS = 256;
const REPLAY_PAGE = 500;
const MAX_REPLAY_PAGES = 40;

/**
 * `WS /ws/board/events?board&after&channel`: replays from `after` (if given),
 * then streams live events. Clients ping at least every 60 s; any other frame
 * closes the socket. A `missed` frame means: reconnect with that cursor.
 */
export function registerBoardEventsWebSocket(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  hub: BoardEventHub;
  service: MessageBoardService;
  resolveCaller(c: Context): BoardCaller | Promise<BoardCaller>;
}): void {
  const { hub, service } = options;
  options.app.get(BOARD_EVENTS_WS_PATH, options.upgradeWebSocket((c) => {
    let handle: BoardSubscriptionHandle | null = null;
    let closed = false;
    return {
      async onOpen(_event, ws) {
        const send = (frame: BoardSocketFrame) => ws.send(JSON.stringify(frame));
        const reject = (reason: "unavailable" | "capacity" | "invalid_input" | "forbidden", code: number) => {
          try {
            send({ type: "error", reason });
          } catch (error: unknown) {
            console.warn("[message-board] socket error send failed:", error instanceof Error ? error.name : "UnknownError");
          }
          ws.close(code, "Board events unavailable");
        };
        try {
          const query = BoardSocketQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
          const caller = await options.resolveCaller(c);
          const board = await service.resolveBoard(caller.ownerId, query.board);
          const subscription = hub.subscribe({
            ownerId: caller.ownerId, boardName: board.name, actorId: caller.actor.id, channel: query.channel,
            send, close: () => { if (!closed) ws.close(1001, "Board events closed"); },
            backlog: () => {
              const raw = ws.raw as { bufferedAmount?: unknown } | undefined;
              return typeof raw?.bufferedAmount === "number" ? raw.bufferedAmount : 0;
            },
          });
          handle = subscription;
          let cursor = String(board.last_cursor);
          if (query.after !== undefined) {
            cursor = query.after;
            for (let page = 0; page < MAX_REPLAY_PAGES; page += 1) {
              const latest = await service.resolveBoard(caller.ownerId, board.name);
              const result = await readBoardEvents(service.db, latest, { after: cursor, limit: REPLAY_PAGE, channel: query.channel });
              if (result.missed) {
                send({ type: "missed", cursor: result.cursor });
              }
              for (const event of result.events) send({ type: "event", event });
              const advanced = result.cursor !== cursor;
              cursor = result.cursor;
              if (!advanced || BigInt(cursor) >= BigInt(latest.last_cursor)) break;
            }
          }
          if (closed) return;
          subscription.live(cursor);
          send({ type: "ready", cursor });
        } catch (error: unknown) {
          handle?.close();
          handle = null;
          if (error instanceof MessageBoardServiceError) {
            reject(error.reason === "unavailable" ? "capacity" : error.reason === "forbidden" ? "forbidden" : "invalid_input", 1013);
            return;
          }
          if (error instanceof Error && error.name === "ZodError") {
            reject("invalid_input", 1008);
            return;
          }
          console.error("[message-board] socket open failed:", error instanceof Error ? error.name : "UnknownError");
          reject("unavailable", 1011);
        }
      },
      onMessage(event, ws) {
        const raw = typeof event.data === "string" ? event.data : null;
        let valid = false;
        if (raw !== null && raw.length <= MAX_CLIENT_FRAME_CHARS) {
          try {
            valid = BoardSocketClientFrameSchema.safeParse(JSON.parse(raw)).success;
          } catch (error: unknown) {
            if (!(error instanceof SyntaxError)) console.warn("[message-board] socket frame parse failed:", error instanceof Error ? error.name : "UnknownError");
          }
        }
        if (!valid) {
          ws.close(1003, "Invalid message");
          return;
        }
        handle?.touch();
        ws.send(JSON.stringify({ type: "pong" } satisfies BoardSocketFrame));
      },
      onClose() {
        closed = true;
        handle?.close();
        handle = null;
      },
    };
  }));
}
