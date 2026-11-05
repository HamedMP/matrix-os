import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatTurnIdSchema } from "#canonical-chat";
import { CanonicalChatEventCursorSchema, CanonicalChatStreamEventSchema } from "#canonical-chat-api";

/**
 * Chat access for apps. Owner-built first-party apps hold every scope by
 * default; any other app holds only what `system/app-capabilities.json` grants.
 * Request bodies are validated by the native Chat route each operation reaches,
 * so apps and native clients share one validation path.
 */
export const APP_CHAT_SCOPES = ["read", "organize", "send", "approve", "delete"] as const;
export const AppChatScopeSchema = z.enum(APP_CHAT_SCOPES);
export type AppChatScope = z.infer<typeof AppChatScopeSchema>;

/** Long-poll bound stays below every host's 35 second bridge timeout. */
export const MAX_APP_CHAT_EVENT_WAIT_MS = 25_000;
/** Matches the largest native Chat request body plus JSON escaping overhead. */
export const MAX_APP_CHAT_REQUEST_BYTES = 256 * 1024;

const Body = z.record(z.string().max(128), z.json());
const ReferenceId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const ClientRequestId = z.string().trim().min(1).max(128);
const ProjectId = z.string().trim().min(1).max(160);
const Limit = (maximum: number) => z.number().int().min(1).max(maximum).optional();
const Lifecycle = z.enum(["active", "archived"]).optional();
const Scope = z.literal("global").optional();
const Cursor = z.string().min(1).max(512).optional();
const Chat = { chatId: CanonicalChatIdSchema };
const Run = { ...Chat, runId: CanonicalChatRunIdSchema };
const op = <Name extends string, Shape extends z.ZodRawShape>(name: Name, shape: Shape) =>
  z.strictObject({ op: z.literal(name), ...shape });

export const AppChatRequestSchema = z.discriminatedUnion("op", [
  op("access", {}),
  op("navigation", { limit: Limit(1000), lifecycle: Lifecycle }),
  op("list", { unread: z.boolean().optional(), limit: Limit(100), lifecycle: Lifecycle, projectId: ProjectId.optional(), scope: Scope, cursor: Cursor }),
  op("search", { query: z.string().trim().min(1).max(200), limit: Limit(100), projectId: ProjectId.optional(), scope: Scope }),
  op("get", { ...Chat, limit: Limit(200), cursor: Cursor }),
  op("turnAdmission", { ...Chat, clientRequestId: ClientRequestId, requestHash: z.string().min(1).max(128) }),
  op("events", { cursor: CanonicalChatEventCursorSchema.optional(), waitMs: z.number().int().min(0).max(MAX_APP_CHAT_EVENT_WAIT_MS).optional() }),
  op("projects", {}),
  op("providers", {}),
  op("create", { body: Body }),
  op("setTitle", { ...Chat, body: Body }),
  op("setProject", { ...Chat, body: Body }),
  op("setPinned", { ...Chat, pinned: z.boolean() }),
  op("setReadState", { ...Chat, body: Body }),
  op("acknowledgeCompletion", { ...Run }),
  op("sendTurn", { ...Chat, body: Body }),
  op("queueTurn", { ...Chat, body: Body }),
  op("updateQueuedTurn", { ...Chat, queuedTurnId: ReferenceId, body: Body }),
  op("cancelQueuedTurn", { ...Chat, queuedTurnId: ReferenceId, body: Body }),
  op("reorderQueuedTurns", { ...Chat, body: Body }),
  op("steerRun", { ...Run, body: Body }),
  op("steerQueuedTurn", { ...Run, queuedTurnId: ReferenceId, body: Body }),
  op("cancelRun", { ...Run, body: Body }),
  op("submitInput", { ...Run, requestId: ReferenceId, body: Body }),
  op("retryTurn", { ...Chat, turnId: CanonicalChatTurnIdSchema, body: Body }),
  op("submitApproval", { ...Run, approvalId: ReferenceId, body: Body }),
  op("delete", { ...Chat, clientRequestId: ClientRequestId }),
]);
export type AppChatRequest = z.infer<typeof AppChatRequestSchema>;
export type AppChatOperation = AppChatRequest["op"];

/** `null` means the operation only reports the caller's own access. */
export const APP_CHAT_OPERATION_SCOPES: Readonly<Record<AppChatOperation, AppChatScope | null>> = Object.freeze({
  access: null,
  navigation: "read", list: "read", search: "read", get: "read", turnAdmission: "read", events: "read", projects: "read", providers: "read",
  create: "organize", setTitle: "organize", setProject: "organize", setPinned: "organize", setReadState: "organize", acknowledgeCompletion: "organize",
  sendTurn: "send", queueTurn: "send", updateQueuedTurn: "send", cancelQueuedTurn: "send", reorderQueuedTurns: "send", steerRun: "send", steerQueuedTurn: "send", cancelRun: "send", submitInput: "send", retryTurn: "send",
  submitApproval: "approve",
  delete: "delete",
});
export const APP_CHAT_OPERATIONS = Object.freeze(Object.keys(APP_CHAT_OPERATION_SCOPES)) as readonly AppChatOperation[];

export const AppChatErrorSchema = z.strictObject({
  code: z.string().min(1).max(128),
  safeMessage: z.string().min(1).max(1024),
  retryable: z.boolean(),
});
export type AppChatErrorBody = z.infer<typeof AppChatErrorSchema>;

/** Hosts discard non-2xx bodies, so Chat outcomes always travel in this envelope. */
export const AppChatReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), status: z.number().int(), result: z.json() }),
  z.strictObject({ ok: z.literal(false), status: z.number().int(), error: AppChatErrorSchema }),
]);
export type AppChatReply = z.infer<typeof AppChatReplySchema>;

export const AppChatEventsResultSchema = z.strictObject({
  events: z.array(CanonicalChatStreamEventSchema).max(100),
  gap: z.boolean(),
  nextCursor: CanonicalChatEventCursorSchema.optional(),
});

function isReply(value: unknown): value is AppChatReply {
  return AppChatReplySchema.safeParse(value).success;
}

/** Client for hosts written in TypeScript. String-injected hosts use `appChatBridgeSource`. */
export function createAppChatClient(invoke: (input: { kind: "chats"; request: AppChatRequest }) => Promise<unknown>) {
  async function request(operation: AppChatOperation, params: Record<string, unknown> = {}): Promise<AppChatReply> {
    const parsed = AppChatRequestSchema.safeParse({ ...params, op: operation });
    if (!parsed.success) return { ok: false, status: 400, error: { code: "invalid_request", safeMessage: "Invalid Chat request.", retryable: false } };
    const reply = await invoke({ kind: "chats", request: parsed.data });
    if (!isReply(reply)) throw new Error("Chat is unavailable");
    return reply;
  }
  const operations = Object.fromEntries(APP_CHAT_OPERATIONS.map(operation => [operation, async (params?: Record<string, unknown>) => {
    const reply = await request(operation, params);
    if (reply.ok) return reply.result;
    throw Object.assign(new Error(reply.error.safeMessage), { code: reply.error.code, status: reply.status, retryable: reply.error.retryable });
  }])) as Record<AppChatOperation, (params?: Record<string, unknown>) => Promise<unknown>>;
  return Object.freeze({ ...operations, request });
}

/**
 * The same client as an ES5 expression for hosts that inject a script string.
 * `invokeExpression` must evaluate to `function(input) -> Promise<reply>`.
 */
export function appChatBridgeSource(invokeExpression: string): string {
  return `(function(){var send=${invokeExpression};var chats={};`
    + `function request(operation,params){return send({kind:"chats",request:Object.assign({},params||{},{op:operation})});}`
    + `chats.request=request;`
    + `${JSON.stringify(APP_CHAT_OPERATIONS)}.forEach(function(operation){chats[operation]=function(params){return request(operation,params).then(function(reply){`
    + `if(reply&&reply.ok===true)return reply.result;`
    + `var failure=reply&&reply.error||{code:"unavailable",safeMessage:"Chat is unavailable.",retryable:true};`
    + `var error=new Error(failure.safeMessage);error.code=failure.code;error.status=reply&&reply.status;error.retryable=failure.retryable;throw error;`
    + `});};});return Object.freeze(chats);})()`;
}
