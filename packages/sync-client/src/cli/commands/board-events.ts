import { BOARD_WAIT_MAX_SECONDS, BoardCursorSchema } from "@matrix-os/contracts/message-board";
import { BoardCliError, boardClientError } from "../board-client.js";
import {
  channelScope, interruptSignal, isMessageId, optionalDuration, printSuccess, usage, type BoardContext, type BoardVerb, type ParsedValues,
} from "../board-cli-support.js";
import { CLI_OUTPUT_VERSION } from "../output.js";
import { formatEvent } from "./board-format.js";

const DEFAULT_WAIT_MS = 30 * 60 * 1000;
/** The long-poll may hold for its wait; give the request that much plus slack. */
const POLL_SLACK_MS = 10_000;

interface EventsPage { events: Array<Record<string, unknown>>; cursor: string; missed: boolean }

function eventsPage(payload: Record<string, unknown>): EventsPage {
  const events = payload.events;
  const cursor = payload.cursor;
  if (!Array.isArray(events) || typeof cursor !== "string" || !BoardCursorSchema.safeParse(cursor).success) {
    throw boardClientError("invalid_response");
  }
  return {
    events: events.filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === "object"),
    cursor,
    missed: payload.missed === true,
  };
}

function scopeQuery(target: string | undefined): Record<string, string> {
  if (isMessageId(target)) return { thread: target };
  const channel = channelScope(target);
  return channel ? { channel } : {};
}

function afterCursor(values: ParsedValues): string | undefined {
  if (values.after === undefined) return undefined;
  if (typeof values.after !== "string" || !BoardCursorSchema.safeParse(values.after).success) usage("--after takes a cursor printed by wait or tail");
  return values.after as string;
}

/** One long-poll of at most 25 s: events after `after` (or from now), filtered to the scope. */
async function poll(ctx: BoardContext, input: { after?: string; waitSeconds: number; scope: Record<string, string>; signal: AbortSignal }) {
  const payload = await ctx.client.request("GET", "/events", {
    query: { ...(input.after ? { after: input.after } : {}), wait: input.waitSeconds, ...input.scope },
    timeoutMs: input.waitSeconds * 1000 + POLL_SLACK_MS,
    signal: input.signal,
  });
  return eventsPage(payload);
}

const wait: BoardVerb = {
  options: { after: { type: "string" }, timeout: { type: "string" } },
  prepare([target], values) {
    const scope = scopeQuery(target);
    const start = afterCursor(values);
    const totalMs = optionalDuration(values.timeout, "--timeout") ?? DEFAULT_WAIT_MS;
    return async (ctx) => {
      const interrupt = interruptSignal(ctx.deps.signals);
      try {
        const deadline = ctx.deps.now() + totalMs;
        let cursor = start;
        let missed = false;
        for (;;) {
          const remainingMs = Math.max(0, deadline - ctx.deps.now());
          const waitSeconds = Math.min(BOARD_WAIT_MAX_SECONDS, Math.ceil(remainingMs / 1000));
          const page = await poll(ctx, { ...(cursor ? { after: cursor } : {}), waitSeconds, scope, signal: interrupt.signal });
          missed ||= page.missed;
          const [event] = page.events;
          if (event) {
            // The event's own cursor: a wait that passes it back sees whatever came after it.
            const next = typeof event.cursor === "string" ? event.cursor : page.cursor;
            printSuccess(ctx.deps.io, ctx.json, { event, cursor: next, ...(missed ? { missed: true } : {}) },
              `${formatEvent(event)}\nnext: matrix board wait${target ? ` ${target}` : ""} --after ${next}`);
            return 0;
          }
          cursor = page.cursor;
          if (deadline - ctx.deps.now() <= 0) {
            throw new BoardCliError("timeout", "Nothing arrived before the timeout.", {
              next: `wait again with --after ${cursor}`, extra: { cursor },
            });
          }
        }
      } finally {
        interrupt.dispose();
      }
    };
  },
};

const tail: BoardVerb = {
  options: { after: { type: "string" } },
  prepare([target], values) {
    const scope = scopeQuery(target);
    const start = afterCursor(values);
    return async (ctx) => {
      const interrupt = interruptSignal(ctx.deps.signals);
      try {
        let cursor = start;
        for (;;) {
          const page = await poll(ctx, { ...(cursor ? { after: cursor } : {}), waitSeconds: BOARD_WAIT_MAX_SECONDS, scope, signal: interrupt.signal });
          if (page.missed) ctx.deps.io.stderr(`Some events are no longer retained; continuing from cursor ${page.cursor}.`);
          for (const event of page.events) {
            ctx.deps.io.stdout(ctx.json ? JSON.stringify({ v: CLI_OUTPUT_VERSION, ok: true, data: { event } }) : formatEvent(event));
          }
          cursor = page.cursor;
          if (interrupt.signal.aborted) throw boardClientError("interrupted");
        }
      } finally {
        interrupt.dispose();
      }
    };
  },
};

export const BOARD_EVENT_VERBS: Record<string, BoardVerb> = { wait, tail };
