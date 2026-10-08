import { z } from "zod/v4";

export { ChatAgentIdSchema as BotIdSchema } from "#chat-agent-context";

const SERVER_ID_BODY = /^[A-Za-z0-9_-]{8,64}$/;

/** Server-generated identifiers only; clients echo them but never mint them. */
function serverId(prefix: string) {
  return z.string()
    .min(prefix.length + 8)
    .max(prefix.length + 64)
    .startsWith(prefix)
    .refine((value) => SERVER_ID_BODY.test(value.slice(prefix.length)), { message: "Invalid identifier" });
}

export const BotInteractionIdSchema = serverId("in_");
export const BotGrantIdSchema = serverId("gr_");
export const BotMemoryItemIdSchema = serverId("mem_");
export const BotTaskIdSchema = serverId("task_");
export const BotRoutineIdSchema = serverId("rt_");
export const BotConnectRequestIdSchema = serverId("cr_");

/** Integration registry slugs, e.g. `gmail`, `google_calendar`. */
export const BotIntegrationServiceSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
/** Connection ids are listed by the server; they are never typed by a person or a model. */
export const BotConnectionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const BotRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const BotBaseRevisionSchema = BotRevisionSchema;
