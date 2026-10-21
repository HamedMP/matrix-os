import { SharedBrowserActionSchema, SHARED_BROWSER_ACTION_DEADLINE_MS } from "@matrix-os/contracts";
import { z } from "zod/v4";

const Reference = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const Session = z.string().min(1).max(512);
const Call = z.string().min(1).max(256);
const Nonce = z.string().regex(/^[a-f0-9]{32}$/);
export const BrowserContextSchema = z.object({
  runId: Reference.optional(), sessionKey: Session.optional(), toolCallId: Call.optional(), toolName: Call.optional(),
}).strict();
export const BrowserBeforeSchema = z.object({
  context: BrowserContextSchema,
  event: z.discriminatedUnion("toolName", [
    z.object({ toolName: z.literal("shared_browser"), params: SharedBrowserActionSchema }).strict(),
    z.object({ toolName: z.enum(["browser", "exec", "execute", "bash", "process", "other"]) }).strict(),
  ]),
}).strict();
const BrowserExecuteFields = z.object({
  sessionKey: Session, toolCallId: Call, callId: Nonce, ticketId: Nonce, action: SharedBrowserActionSchema,
}).strict();
// The authority issues this one-use ticket before dispatch, so it can authenticate early cancellation too.
const matchesTicket = (value: { callId: string; ticketId: string }) => value.callId === value.ticketId;
export const BrowserExecuteSchema = BrowserExecuteFields.refine(matchesTicket);
export const BrowserCancelSchema = BrowserExecuteFields.pick({ sessionKey: true, toolCallId: true, callId: true, ticketId: true }).strict().refine(matchesTicket);
export const BrowserEndSchema = z.object({ runId: Reference, sessionKey: Session }).strict();
export const BROWSER_AUTHORITY_METHODS = {
  "matrix.browser.before": BrowserBeforeSchema,
  "matrix.browser.execute": BrowserExecuteSchema,
  "matrix.browser.cancel": BrowserCancelSchema,
  "matrix.browser.end": BrowserEndSchema,
} as const;
export const BROWSER_AUTHORITY_TIMEOUT_MS = SHARED_BROWSER_ACTION_DEADLINE_MS + 10_000;
export const BROWSER_AUTHORITY_REQUEST_MAX_BYTES = 64 * 1024;
export const BrowserBeforeResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("allow") }).strict(),
  z.object({ kind: z.literal("block") }).strict(),
  z.object({ kind: z.literal("ticket"), ticketId: Nonce, action: SharedBrowserActionSchema }).strict(),
]);
export const BrowserToolResultSchema = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string().max(192 * 1024) }).strict()).max(1) }).strict();
export const BROWSER_TICKET = "__matrix_browser_ticket";
export const BrowserToolInputSchema = z.object({ [BROWSER_TICKET]: Nonce }).passthrough();

export const BrowserCancelResultSchema = z.object({ cancelled: z.boolean(), settled: z.literal(true) }).strict();
