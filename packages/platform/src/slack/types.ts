import type { Context } from "hono";
import { z } from "zod/v4";

export const SlackAppIdSchema = z.string().regex(/^A[A-Z0-9]{2,63}$/);
export const SlackTeamIdSchema = z.string().regex(/^T[A-Z0-9]{2,63}$/);
export const SlackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]{2,63}$/);
export const SlackChannelIdSchema = z.string().regex(/^[CDG][A-Z0-9]{2,63}$/);
export const SlackTimestampSchema = z.string().regex(/^\d{1,16}\.\d{1,8}$/);
export const OrganizationIdSchema = z.string().regex(/^org_[A-Za-z0-9_-]{1,124}$/);
export const ActorIdSchema = z.string().regex(/^user_[A-Za-z0-9_-]{1,123}$/);
export const SlackTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export interface SlackInstallation {
  appId: string; teamId: string; organizationId: string; installedBy: string;
  botUserId: string; encryptedBotToken: string; generation: number; state: "active" | "revoked";
}
export interface SlackEmployeeLink { appId: string; teamId: string; slackUserId: string; actorId: string; organizationId: string }
export interface SlackChannelBinding { appId: string; teamId: string; channelId: string; organizationId: string; scopeId: string; approvedOutput: boolean; configuredBy: string }
export interface SlackInboundEvent {
  eventId: string; appId: string; teamId: string; userId: string; channelId: string;
  ts: string; threadTs?: string; text: string; kind: "mention" | "direct_message";
}
export interface SlackAppConfig {
  appId: string; clientId: string; clientSecret: string; signingSecret: string;
  tokenEncryptionKey: string; publicBaseUrl: string;
}
export interface SlackApi {
  exchangeCode(input: { code: string; redirectUri: string }): Promise<{ appId: string; teamId: string; botUserId: string; botToken: string }>;
  postMessage(input: { token: string; channelId: string; text: string; threadTs?: string; signal?: AbortSignal }): Promise<{ ts: string }>;
  replies(input: { token: string; channelId: string; ts: string; cursor?: string; signal?: AbortSignal }): Promise<SlackMessagePage>;
  history(input: { token: string; channelId: string; cursor?: string; signal?: AbortSignal }): Promise<SlackMessagePage>;
  conversationInfo(input: { token: string; channelId: string; signal?: AbortSignal }): Promise<{ isExternalShared: boolean; canAccess: boolean }>;
  addReaction(input: { token: string; channelId: string; ts: string; name: string; signal?: AbortSignal }): Promise<void>;
}
export interface SlackMessagePage { messages: Array<{ user?: string; text?: string; ts: string; thread_ts?: string }>; nextCursor?: string; hasMore: boolean }
export interface SlackAuthorityDependencies {
  resolveActor(c: Context): Promise<string | null>;
  /** Must independently fetch/validate fresh membership AND administrator authority. */
  requireOrgAdmin(input: { actorId: string; organizationId: string }): Promise<boolean>;
  isCurrentMember(input: { actorId: string; organizationId: string }): Promise<boolean>;
  /** Must resolve existing collaboration scope, owner/runtime, organization and manage authority. */
  authorizeChannelBinding(input: SlackChannelBinding & { actorId: string }): Promise<boolean>;
  /** Must durably commit to the selected owner home; dedup by app/team/eventId. A resolved promise acknowledges that commit. */
  dispatch(input: { installation: SlackInstallation; link: SlackEmployeeLink; binding: SlackChannelBinding | null; event: SlackInboundEvent; signal: AbortSignal }): Promise<{ ownerId: string }>;
  authenticateRuntime?(c: Context): Promise<{ ownerId: string } | null>;
  authorizeReply?(input: { installation: SlackInstallation; destination: SlackReplyDestination; ownerId: string; publication?: { textDigest: string } }): Promise<boolean>;
}

export interface SlackReplyDestination { appId: string; teamId: string; eventId: string; ownerId: string; actorId: string; slackUserId: string; organizationId: string; channelId: string; threadTs: string; eventTs?: string; scopeId: string | null; installationGeneration: number }
