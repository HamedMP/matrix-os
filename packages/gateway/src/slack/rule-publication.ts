import { routedSlackPublicationCurrent, type SlackAgentRouteSnapshot } from "./agent-routes.js";
import { sql, type QueryExecutorProvider } from "kysely";
/** Caller holds the canonical Chat lock. Rule mutations take that lock before changing revision. */
export async function slackRulePublicationCurrent(db: QueryExecutorProvider, ownerId: string, chatId: string, requestId: string): Promise<boolean> {
    if (!requestId.startsWith("req_slack_summary_"))
        return true;
    const exists = await sql<{
        ready: boolean;
    }> `SELECT to_regclass('slack_mention_summary_jobs') IS NOT NULL AS ready`.execute(db);
    if (!exists.rows[0]?.ready)
        return false; // Legacy private automatic path; prepareRun separately proves its job.
    const routed = await sql<{route:SlackAgentRouteSnapshot; bot_id:string}>`SELECT to_jsonb(job)->'routed' AS route, bot_id
      FROM slack_mention_summary_jobs job WHERE owner_id=${ownerId} AND chat_id=${chatId} AND request_id=${requestId}
        AND to_jsonb(job)->>'routed' IS NOT NULL`.execute(db);
    const jobRoute = routed.rows[0];
    if (jobRoute) {
      const route = jobRoute.route;
      if (route.ownerId !== ownerId || route.chatId !== chatId || route.agentId !== jobRoute.bot_id) return false;
      const active = await sql`SELECT 1 FROM slack_mention_summary_jobs WHERE request_id=${requestId}
        AND expires_at>now() AND state IN ('processing','accepted','completed')
        AND (routed->>'kind'='summary' OR (routed->>'kind'='review' AND review_patch IS NOT NULL))`.execute(db);
      return active.rows.length === 1 && await routedSlackPublicationCurrent(db,route);
    }
    const result = await sql<{
        policy: unknown;
        valid: boolean;
    }> `SELECT job.policy,
   job.expires_at>now() AND job.state IN ('processing','accepted','completed') AND CASE WHEN job.policy IS NULL THEN NOT EXISTS(SELECT 1 FROM slack_summary_rules migrated WHERE migrated.owner_id=${ownerId} AND migrated.bot_id=job.bot_id AND migrated.grant_id=job.envelope->>'grantId') ELSE EXISTS(SELECT 1 FROM slack_summary_rules rule JOIN bot_chat_bindings binding ON binding.owner_id=rule.owner_id AND binding.bot_id=rule.bot_id AND binding.chat_id=rule.chat_id
    WHERE rule.rule_id=job.policy->>'ruleId' AND rule.owner_id=${ownerId} AND rule.chat_id=${chatId}
     AND rule.bot_id=job.bot_id AND rule.grant_id=job.policy->>'grantId' AND rule.runtime_id=job.policy->>'runtimeId'
     AND rule.revision=(job.policy->>'revision')::bigint AND rule.status='active' AND binding.kind='direct' AND binding.removed_at IS NULL AND EXISTS(SELECT 1 FROM chats chat WHERE chat.id=rule.chat_id AND chat.owner_id=rule.owner_id AND chat.owner_type='personal' AND chat.lifecycle='active' AND chat.project_id IS NULL AND chat.collaboration IS NULL)) END AS valid
   FROM slack_mention_summary_jobs job WHERE job.owner_id=${ownerId} AND job.chat_id=${chatId} AND job.request_id=${requestId}`.execute(db);
    const job = result.rows[0];
    return Boolean(job?.valid);
}
