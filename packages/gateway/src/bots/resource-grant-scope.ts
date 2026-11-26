import { BotConnectionIdSchema, BotResourceGrantCandidateSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

export const GithubReviewRepositorySchema = z.strictObject({
  repositoryId: z.string().regex(/^[1-9][0-9]{0,15}$/).refine((id) => Number.isSafeInteger(Number(id))),
  fullName: z.string().max(256).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9._-]+$/)
    .refine((value) => !/\/(?:\.|\.\.)$/.test(value)).transform((value) => value.toLowerCase()),
});

export const BotResourceScopeSchema = z.discriminatedUnion("kind", [
  GithubReviewRepositorySchema.extend({ kind: z.literal("github_repository") }),
  z.strictObject({
    kind: z.literal("slack_channel"),
    teamId: z.string().regex(/^T[A-Z0-9]{1,31}$/),
    channelId: z.string().regex(/^[CG][A-Z0-9]{1,31}$/),
  }),
]);

export const ResourceProviderCandidateSchema = z.strictObject({
  connectionId: BotConnectionIdSchema,
  label: BotResourceGrantCandidateSchema.shape.label,
  scope: BotResourceScopeSchema,
});

export type BotResourceScope = z.infer<typeof BotResourceScopeSchema>;
export type BotResourceGrantCandidate = z.input<typeof ResourceProviderCandidateSchema>;
export type BotResourceGrantTarget = { ownerId: string; agentId: string; chatId: string };

/** Discovery must verify the owner, current provider connection and approved resource as one candidate. */
export interface BotResourceGrantProviders {
  list(input: BotResourceGrantTarget, signal?: AbortSignal): Promise<readonly BotResourceGrantCandidate[]>;
}
