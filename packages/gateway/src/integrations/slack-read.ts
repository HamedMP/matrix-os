import { z } from "zod/v4";
import type { ServiceAction } from "./types.js";

export const SLACK_READ_ACTIONS: Record<string, ServiceAction> = {
  list_thread_replies: {
    description: "Read one page of a selected channel thread; continue response_metadata.next_cursor; token needs channel history read access",
    risk: "read",
    params: {
      channel: { type: "string", required: true }, ts: { type: "string", required: true },
      cursor: { type: "string" }, limit: { type: "number" },
    },
    paramsSchema: z.strictObject({
      channel: z.string().regex(/^[CG][A-Z0-9]{8,20}$/),
      ts: z.string().regex(/^\d{1,16}\.\d{6}$/),
      cursor: z.string().min(1).max(2048).regex(/^[^\s\x00-\x1f\x7f]+$/).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    directApi: {
      method: "GET", url: "https://slack.com/api/conversations.replies",
      mapParams: (p) => ({
        channel: String(p.channel), ts: String(p.ts),
        ...(p.cursor !== undefined ? { cursor: String(p.cursor) } : {}),
        // Conservative default for commercially distributed installations.
        limit: String(p.limit ?? 15),
      }),
    },
  },
};
