import { z } from "zod/v4";
import { canonicalSafeLabel } from "#canonical-chat-primitives";
import { IsoTimestampSchema } from "#contract-primitives";
import { BotBaseRevisionSchema, BotGrantIdSchema, BotIntegrationServiceSchema, BotRevisionSchema } from "#bots/ids";

export const BotEffectSchema = z.enum(["read", "write", "send", "label"]);

/** `direct` is the bot's own conversation; `group:<chatId>` is one shared chat (M3). */
export const BotAudienceSchema = z.union([
  z.literal("direct"),
  z.string().regex(/^group:chat_[A-Za-z0-9_-]{1,128}$/),
]);

export const BotEffectListSchema = z.array(BotEffectSchema).min(1).max(4)
  .refine((effects) => new Set(effects).size === effects.length, { message: "Effects must be unique" });

export const BotAccountLabelSchema = canonicalSafeLabel(120, 480);

/** Owner-visible projection; external account identifiers never leave the server. */
export const BotGrantSchema = z.object({
  grantId: BotGrantIdSchema,
  service: BotIntegrationServiceSchema,
  accountLabel: BotAccountLabelSchema,
  effects: BotEffectListSchema,
  audience: BotAudienceSchema,
  expiresAt: IsoTimestampSchema.nullable(),
}).strict();

export const RevokeBotGrantResponseSchema = z.object({
  grantId: BotGrantIdSchema,
  revokedAt: IsoTimestampSchema,
}).strict();

export type BotEffect = z.infer<typeof BotEffectSchema>;

/** Shared consent and saved-authority copy for every Bot surface. */
export function botIntegrationAccessCopy(service: string, effects: readonly BotEffect[]): { summary: string; boundary: string | null } {
  const jevLabels = service === "gmail" && effects.includes("label");
  const summary = effects.map((effect) => effect === "label" ? "add Jev classification labels"
    : effect === "read" && jevLabels ? "read Inbox" : effect).join(", ");
  return { summary, boundary: jevLabels && effects.every((effect) => effect === "read" || effect === "label")
    ? "Preserve existing labels; no archive, send, delete, or mark read." : null };
}
export type BotAudience = z.infer<typeof BotAudienceSchema>;
export type BotGrant = z.infer<typeof BotGrantSchema>;
export type RevokeBotGrantResponse = z.infer<typeof RevokeBotGrantResponseSchema>;

export const BotResourceGrantKindSchema = z.enum(["slack_channel", "github_repository"]);
export const BotResourceGrantCandidateIdSchema = z.string().regex(/^source_[a-f0-9]{48}$/);
export const BotResourceGrantIdSchema = z.string().regex(/^rgr_[a-f0-9]{32}$/);

export const BotResourceGrantCandidateSchema = z.strictObject({
  id: BotResourceGrantCandidateIdSchema,
  kind: BotResourceGrantKindSchema,
  label: canonicalSafeLabel(256, 1024),
});

export const BotResourceGrantSchema = BotResourceGrantCandidateSchema.extend({
  id: BotResourceGrantIdSchema,
  revision: BotRevisionSchema,
});

export const BotResourceGrantListSchema = z.strictObject({
  candidates: z.array(BotResourceGrantCandidateSchema).max(32),
  grants: z.array(BotResourceGrantSchema).max(2),
});

export const BotResourceGrantCreateSchema = z.strictObject({ candidateId: BotResourceGrantCandidateIdSchema });
export const BotResourceGrantCreateResponseSchema = z.strictObject({ grant: BotResourceGrantSchema });
export const BotResourceGrantRevokeSchema = z.strictObject({ baseRevision: BotBaseRevisionSchema });
export const BotResourceGrantRevokeResponseSchema = z.strictObject({
  grantId: BotResourceGrantIdSchema,
  revokedAt: IsoTimestampSchema,
});

export type BotResourceGrant = z.infer<typeof BotResourceGrantSchema>;
export type BotResourceGrantList = z.infer<typeof BotResourceGrantListSchema>;
export type BotResourceGrantKind = z.infer<typeof BotResourceGrantKindSchema>;
