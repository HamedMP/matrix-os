import { z } from "zod/v4";
import type { ServiceAction } from "./types.js";
/** A normal read action; enrollment adapters narrow its account/channel arguments separately. */
export const SLACK_THREAD_READ_ACTION: ServiceAction = { description: "Read a Slack thread root and replies", risk: "read",
  paramsSchema: z.object({ channel: z.string().regex(/^[CDG][A-Z0-9]{2,63}$/), ts: z.string().regex(/^\d{1,16}\.\d{1,8}$/), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(1024).optional() }).strict(),
  params: { channel: { type: "string", required: true }, ts: { type: "string", required: true }, limit: { type: "number" }, cursor: { type: "string" } },
  directApi: { method: "GET", url: "https://slack.com/api/conversations.replies", mapParams: p => ({ channel: String(p.channel), ts: String(p.ts), limit: String(p.limit ?? 15), ...(p.cursor ? { cursor: String(p.cursor) } : {}) }) },
};
