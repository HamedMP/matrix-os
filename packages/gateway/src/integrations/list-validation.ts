import { z } from "zod/v4";

const text = z.string().max(4096);
const cursor = z.string().min(1).max(2048).regex(/^[^\s\x00-\x1f\x7f]+$/).optional();
const limit = (max: number) => z.number().int().min(1).max(max).optional();
const page = limit(1000000);
const repo = z.string().max(256).regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
  .refine((s) => s.split("/").every((part) => part !== "." && part !== ".."));
const snowflake = z.string().regex(/^\d{1,20}$/).optional();
const discordPaging = { before: snowflake, after: snowflake };

export const listValidation = {
  calendar: z.strictObject({ timeMin: text.optional(), timeMax: text.optional(), maxResults: limit(2500), pageToken: cursor }),
  drive: z.strictObject({ query: text.optional(), folderId: text.optional(), maxResults: limit(1000), pageToken: cursor }),
  repos: z.strictObject({ sort: z.enum(["created", "updated", "pushed", "full_name"]).optional(), per_page: limit(100), page }),
  issues: z.strictObject({ repo, state: z.enum(["open", "closed", "all"]).optional(), per_page: limit(100), page }),
  notifications: z.strictObject({ all: z.boolean().optional(), per_page: limit(100), page }),
  channels: z.strictObject({ limit: limit(1000), cursor }),
  messages: z.strictObject({ channel: text.min(1), limit: limit(100), cursor }),
  search: z.strictObject({ query: text, page, count: limit(100) }),
  servers: z.strictObject({ ...discordPaging, limit: limit(200) })
    .refine((p) => !(p.before && p.after)),
  discordMessages: z.strictObject({ channelId: z.string().regex(/^\d{17,20}$/), ...discordPaging, limit: limit(100) })
    .refine((p) => !(p.before && p.after)),
};
