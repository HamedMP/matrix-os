/**
 * Routing a free-text request in the agent panel to one feature. Pure and
 * deliberately simple: explicit words win, then the open thread decides.
 */

export type MailIntentKind = "reply" | "new" | "summarize" | "search" | "triage";

export interface MailIntent {
  kind: MailIntentKind;
  /** The owner's text, passed on as the instruction or question. */
  text: string;
}

export interface IntentContext {
  hasThread: boolean;
  hasSelection: boolean;
}

const SUMMARIZE = /\b(summari[sz]e|summary|tl;?dr|recap|what is this (thread|email|about)|catch me up)\b/i;
const TRIAGE = /\b(triage|tidy|clean ?up|organi[sz]e|sort (these|them|my)|file (these|them)|which (folder|label))\b/i;
const SEARCH = /^(find|search|look ?(for|up)|where|which|when did|who (sent|wrote)|show me|get me|dig up)\b|\b(find|search for|look for)\b/i;
const REPLY = /\b(reply|respond|answer|write back|get back to)\b/i;
const NEW = /\b(write|draft|compose|email|send|message|ask|invite|tell|follow up with)\b/i;
/** With a thread open, a new message needs an address or explicit words; anything else is a reply. */
const EXPLICIT_NEW = /[^\s@]+@[^\s@]+\.[a-z]{2,}|\b(new (email|message|mail)|compose|write to|email to)\b/i;

export function routeIntent(input: string, context: IntentContext): MailIntent {
  const text = input.trim();
  if (SUMMARIZE.test(text) && context.hasThread) return { kind: "summarize", text };
  if (TRIAGE.test(text) && (context.hasSelection || context.hasThread)) return { kind: "triage", text };
  if (SEARCH.test(text)) return { kind: "search", text };
  if (REPLY.test(text) && context.hasThread) return { kind: "reply", text };
  if (context.hasThread ? EXPLICIT_NEW.test(text) : NEW.test(text)) return { kind: "new", text };
  if (context.hasThread) return { kind: "reply", text };
  return /\?$/.test(text) || text.split(/\s+/).length <= 8 ? { kind: "search", text } : { kind: "new", text };
}
