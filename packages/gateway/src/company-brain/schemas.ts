import { z } from "zod/v4";

export const BrainScopeIdSchema = z.uuid();
export const BrainSourceIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const BrainRevisionSchema = z.number().int().min(0).max(2_147_483_646);
const PermalinkSchema = z.string().max(2048).url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "A credential-free HTTPS source link is required");
export const PublishBrainSourceSchema = z.object({
  sourceId: BrainSourceIdSchema,
  audienceScopeId: BrainScopeIdSchema,
  title: z.string().trim().min(1).max(300),
  text: z.string().min(1).max(65_536),
  permalink: PermalinkSchema,
  sourceUpdatedAt: z.iso.datetime({ offset: true }),
  expectedRevision: BrainRevisionSchema,
}).strict().refine((value) => Buffer.byteLength(value.text, "utf8") + Buffer.byteLength(value.title, "utf8") <= 65_536, "Source is too large");
export const SearchBrainSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(5),
}).strict();
export type PublishBrainSource = z.input<typeof PublishBrainSourceSchema>;
export type SearchBrain = z.input<typeof SearchBrainSchema>;
