import { sql, type QueryExecutorProvider } from "kysely";
import { isDeepStrictEqual } from "node:util";
import type { SlackAgentChannel, RoutedSlackEvent } from "@matrix-os/contracts/slack-bridge";
import type { BotStateTransactions } from "../bots/events.js";
import { BotResourceScopeSchema } from "../bots/resource-grant-scope.js";
import { hasNonPrivateChatScopeSql, hasOtherBotBindingSql } from "../chat/private-routine-authority.js";

export type { RoutedSlackEvent };
export type SlackAgentRouteSnapshot = Omit<SlackAgentChannel, "name"> & {
  agentId: string; chatId: string; routeId: string; revision: number; kind: "summary" | "review";
  github?: { repositoryId: string; fullName: string; connectionId: string; grantId: string; revision: number };
};
type Address = Pick<SlackAgentChannel, "ownerId" | "runtimeId" | "appId" | "teamId" | "channelId" | "installationGeneration" | "sourceId">;

export function attestsSlackAgentRoute(snapshot: SlackAgentRouteSnapshot, channels: readonly SlackAgentChannel[]) {
  return channels.some(c => c.ownerId === snapshot.ownerId && c.runtimeId === snapshot.runtimeId
    && c.appId === snapshot.appId && c.teamId === snapshot.teamId && c.channelId === snapshot.channelId
    && c.installationGeneration === snapshot.installationGeneration && c.sourceId === snapshot.sourceId
    && c.senderId === snapshot.senderId && c.channelSummary === snapshot.channelSummary);
}

export function matchesSlackRouteSender(route: SlackAgentRouteSnapshot, event: RoutedSlackEvent) {
  return route.kind === "summary" && route.channelSummary === true
    || route.senderId === event.userId && !event.botId;
}

/** A route belongs to exactly one owner and channel. All grant additions serialize on the owner's Agent lock. */
export async function occupiedRouteChannel(db: QueryExecutorProvider, ownerId: string, appId: string, teamId: string, channelId: string, exceptAgent: string) {
  const found = await sql`SELECT 1 FROM bot_resource_grants WHERE owner_id=${ownerId} AND bot_id<>${exceptAgent}
    AND kind='slack_channel' AND revoked_at IS NULL AND scope->'route'->>'appId'=${appId}
    AND scope->>'teamId'=${teamId} AND scope->>'channelId'=${channelId} LIMIT 1`.execute(db);
  return found.rows.length !== 0;
}

async function readRoute(db: QueryExecutorProvider, address: Address) {
  const { ownerId, runtimeId, appId, teamId, channelId, installationGeneration, sourceId } = address;
  // Read up to two grants before filtering by recipient. Ambiguous rows can never become fan-out.
  const records = await sql<{ grant_id: string; revision: string; scope: unknown; bot_id: string; chat_id: string; created_at: Date }>`
    SELECT grant_id, revision, scope, bot_id, chat_id, created_at FROM bot_resource_grants
    WHERE owner_id=${ownerId} AND kind='slack_channel' AND revoked_at IS NULL
      AND scope->'route'->>'appId'=${appId} AND scope->>'teamId'=${teamId} AND scope->>'channelId'=${channelId}
    ORDER BY grant_id LIMIT 2 FOR SHARE`.execute(db);
  if (records.rows.length !== 1) return null;
  const row = records.rows[0]!;
  const parsed = BotResourceScopeSchema.safeParse(row.scope);
  if (!parsed.success || parsed.data.kind !== "slack_channel") return null;
  const route = parsed.data.route;
  if (!route || route.ownerId !== ownerId || route.runtimeId !== runtimeId || route.sourceId !== sourceId
    || route.installationGeneration !== installationGeneration || (route.channelSummary && route.kind !== "summary")) return null;
  const privateBinding = await sql`SELECT 1 FROM bot_resource_grants g
    INNER JOIN bot_chat_bindings b ON b.bot_id=g.bot_id AND b.owner_id=g.owner_id AND b.chat_id=g.chat_id
    INNER JOIN chats c ON c.id=b.chat_id AND c.owner_id=b.owner_id
    WHERE g.grant_id=${row.grant_id} AND b.created_at=g.binding_created_at AND b.kind='direct' AND b.removed_at IS NULL
      AND c.owner_type='personal' AND c.lifecycle='active' AND c.project_id IS NULL AND c.collaboration IS NULL
      AND NOT ${hasOtherBotBindingSql(sql.ref("c.id"), sql.ref("b.bot_id"))}
      AND NOT ${hasNonPrivateChatScopeSql(sql.ref("c.owner_type"), sql.ref("c.owner_id"), sql.ref("c.id"))}
      AND NOT EXISTS(SELECT 1 FROM chat_shares share WHERE share.chat_id=c.id AND share.expires_at>now())
    FOR SHARE OF b,c`.execute(db);
  if (!privateBinding.rows.length) return null;
  let github: SlackAgentRouteSnapshot["github"];
  if (route.kind === "review") {
    if (!route.repoGrantId) return null;
    const grants = await sql<{ grant_id: string; revision: string; connection_id: string; scope: unknown }>`
      SELECT r.grant_id,r.revision,r.connection_id,r.scope FROM bot_resource_grants r JOIN bot_resource_grants g
        ON r.owner_id=g.owner_id AND r.bot_id=g.bot_id AND r.chat_id=g.chat_id AND r.binding_created_at=g.binding_created_at
      WHERE g.grant_id=${row.grant_id} AND r.kind='github_repository' AND r.grant_id=${route.repoGrantId} AND r.revoked_at IS NULL FOR SHARE OF r`.execute(db);
    const grant = grants.rows[0];
    const scope = BotResourceScopeSchema.safeParse(grant?.scope);
    if (!grant || !scope.success || scope.data.kind !== "github_repository") return null;
    github = { connectionId: grant.connection_id, grantId: grant.grant_id, revision: Number(grant.revision),
      repositoryId: scope.data.repositoryId, fullName: scope.data.fullName };
  }
  const snapshot: SlackAgentRouteSnapshot = { ownerId, runtimeId, appId, teamId, channelId, installationGeneration, sourceId,
    agentId: row.bot_id, chatId: row.chat_id, routeId: row.grant_id, revision: Number(row.revision),
    senderId: route.senderId, kind: route.kind, ...(route.channelSummary ? { channelSummary: true } : {}), ...(github ? { github } : {}) };
  return { snapshot, enabledAt: new Date(row.created_at).getTime() };
}

export async function routedSlackPublicationCurrent(db: QueryExecutorProvider, snapshot: SlackAgentRouteSnapshot): Promise<boolean> {
  const current = await readRoute(db, snapshot);
  return Boolean(current && isDeepStrictEqual(snapshot, current.snapshot));
}

export function createSlackAgentRouteResolver(deps: { ownerId: string; runtimeId: string; transact: BotStateTransactions;
  isActiveManagedAgent(ownerId: string, agentId: string): Promise<boolean> }) {
  return {
    async resolve(event: RoutedSlackEvent, tx: QueryExecutorProvider): Promise<SlackAgentRouteSnapshot | null> {
      if (event.ownerId !== deps.ownerId || event.runtimeId !== deps.runtimeId) return null;
      const found = await readRoute(tx, event);
      if (!found || !matchesSlackRouteSender(found.snapshot, event) || Number(event.ts) * 1000 < found.enabledAt
        || !await deps.isActiveManagedAgent(deps.ownerId, found.snapshot.agentId)) return null;
      return found.snapshot;
    },
    async current(snapshot: SlackAgentRouteSnapshot, tx?: QueryExecutorProvider): Promise<boolean> {
      if (deps.ownerId !== snapshot.ownerId || deps.runtimeId !== snapshot.runtimeId
        || !await deps.isActiveManagedAgent(deps.ownerId, snapshot.agentId)) return false;
      return tx ? routedSlackPublicationCurrent(tx, snapshot) : deps.transact(deps.ownerId, t => routedSlackPublicationCurrent(t.db, snapshot));
    },
  };
}
