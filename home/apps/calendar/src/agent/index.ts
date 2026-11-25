/**
 * Calendar agent: plain-language requests in, typed answers out.
 *
 *   const answer = await runCalendarAgent("when are we all free this week", context, deps);
 *
 * One model call (`deps.generate`) turns the request into a `CalendarIntent`;
 * everything after that runs in code against the calendar model: relative
 * dates are resolved from `context.now` and `context.timeZone`, availability
 * comes from `deps.listEvents` and `deps.getFreeBusy`, and slots from
 * `findSlots`. Write requests come back as an `EventDraft` (kind "draft"),
 * agent proposals (kind "proposals") or candidate times for an existing event
 * (kind "reschedule"); nothing is ever created or sent from here.
 */
import { executeIntent } from "./execute";
import { parseIntentReply } from "./parse-intent";
import { buildIntentPrompt, MAX_REQUEST_CHARS } from "./prompt";
import type { CalendarAgentAnswer, CalendarAgentContext, CalendarAgentDeps, CalendarIntent } from "./types";

export * from "./types";
export { buildIntentPrompt, knownPeople, quoteData, MAX_PROMPT_CHARS, MAX_PROMPT_EVENTS, MAX_PROMPT_PEOPLE, MAX_REQUEST_CHARS } from "./prompt";
export type { IntentPrompt, PeopleEntry } from "./prompt";
export { extractJsonObject, parseIntentReply, validateIntent } from "./parse-intent";
export {
  MAX_WINDOW_DAYS,
  endOfDayInstant,
  parseDateRef,
  parseWallTime,
  parseWindowRef,
  resolveDateRef,
  resolveWindow,
  todayKey,
} from "./relative-dates";
export type { DateContext } from "./relative-dates";
export { ownerBusyBlocks, resolvePeople, searchAvailability } from "./availability";
export { executeIntent } from "./execute";
export { dayLabel, eventLabel, rangeLabel, slotLabel, windowLabel } from "./describe";

/** How long one model call may take before the agent gives up. The bridge itself stops at 35 s. */
export const GENERATE_TIMEOUT_MS = 40_000;

export const UNAVAILABLE_MESSAGE = "The assistant is not available right now. Try again.";
export const NOT_UNDERSTOOD_MESSAGE = "I did not understand that. Try asking about your agenda, free time, or a meeting to set up.";

export interface RunOptions {
  /** Called with the parsed intent before it runs, for progress display. */
  onIntent?(intent: CalendarIntent): void;
  /** Overrides `GENERATE_TIMEOUT_MS` (tests). */
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Calendar agent timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function failure(text: string): CalendarAgentAnswer {
  return { kind: "error", text, notes: [], events: [], slots: [] };
}

/** Interprets and answers one request. Resolves with an answer; never rejects for model or provider failures. */
export async function runCalendarAgent(
  request: string,
  context: CalendarAgentContext,
  deps: CalendarAgentDeps,
  options: RunOptions = {},
): Promise<CalendarAgentAnswer> {
  const text = typeof request === "string" ? request.trim().slice(0, MAX_REQUEST_CHARS) : "";
  if (!text) return { kind: "clarify", text: "What would you like to know or set up?", notes: [], events: [], slots: [] };
  const { prompt, aliases, people } = buildIntentPrompt(text, context);
  let reply: string;
  try {
    reply = await withTimeout(deps.generate(prompt), options.timeoutMs ?? GENERATE_TIMEOUT_MS);
  } catch (error: unknown) {
    deps.log?.("agent: generate", error);
    return failure(UNAVAILABLE_MESSAGE);
  }
  const intent = parseIntentReply(reply, aliases);
  if (!intent) return { kind: "clarify", text: NOT_UNDERSTOOD_MESSAGE, notes: [], events: [], slots: [] };
  options.onIntent?.(intent);
  try {
    return await executeIntent(intent, { context, deps, people, aliases });
  } catch (error: unknown) {
    deps.log?.("agent: execute", error);
    return failure("Something went wrong. Try again.");
  }
}
