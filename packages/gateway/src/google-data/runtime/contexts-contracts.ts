import { z } from "zod/v4";

export const contextOpaque = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const accountId = z.uuid().transform(value => value.toLowerCase());
export const contextMarkSchema = z.object({
  ownerId: contextOpaque, chatId: contextOpaque, googleAccountId: accountId,
  consentId: contextOpaque, profileId: contextOpaque, profileRevision: z.number().int().positive().max(2_147_483_647),
  purposeId: contextOpaque, expiresAt: z.iso.datetime(), retentionDeadline: z.iso.datetime(),
  expectedRevision: z.number().int().positive().max(2_147_483_647).optional(),
}).strict();
export type GoogleContextMark = z.infer<typeof contextMarkSchema>;
export interface GoogleContextSource {
  originId: string; googleAccountId: string; consentId: string; profileId: string; profileRevision: number;
  purposeId: string; expiresAt: string; state: "active" | "purging";
}
export interface GoogleContext {
  ownerId: string; chatId: string; revision: number; retentionDeadline: string;
  availability: "available" | "expired" | "purging" | "deleted"; sources: GoogleContextSource[];
}
export interface GoogleContextLimits {
  maxContexts: number; maxContextsPerOwner: number; maxSources: number; maxSourcesPerOwner: number; maxSourcesPerContext: number;
}
export interface GoogleContextDeletionAuthority {
  /** Host verifies the actual owned content deleted and holds its admission through the metadata transaction.
   * Never take an owner HTTP boolean as this authority. Null means unavailable. */
  withVerifiedContextDeletion<T>(ownerId: string, chatId: string, work: () => Promise<T>): Promise<T | null>;
}
export interface GoogleContextOwnerDeletionAuthority {
  /** Host must revoke account access, drain live AND queued writes, and retain the existing
   * account-deletion admission through commit. Returning null denies finalization. */
  withOwnerDeletionAdmission<T>(ownerId: string, work: () => Promise<T>): Promise<T | null>;
}
export interface GoogleContextOptions {
  now?: () => Date; limits?: Partial<GoogleContextLimits>; deletionAuthority?: GoogleContextDeletionAuthority;
  ownerDeletionAuthority?: GoogleContextOwnerDeletionAuthority;
}
export const contextDefaults: GoogleContextLimits = {
  maxContexts: 200_000, maxContextsPerOwner: 10_000, maxSources: 200_000, maxSourcesPerOwner: 10_000, maxSourcesPerContext: 32,
};
export class GoogleContextUnavailable extends Error {
  constructor() { super("Google context unavailable"); this.name = "GoogleContextUnavailable"; }
}
export function contextDeny(): never { throw new GoogleContextUnavailable(); }
export function contextLimits(input: Partial<GoogleContextLimits> = {}): GoogleContextLimits {
  const cap = { ...contextDefaults, ...input };
  for (const [key, value] of Object.entries(cap)) {
    if (!Number.isInteger(value) || value < 1 || value > contextDefaults[key as keyof GoogleContextLimits]) contextDeny();
  }
  return cap;
}
