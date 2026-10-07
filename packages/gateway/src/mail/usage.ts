import { sql, type Kysely } from 'kysely';
import { z } from 'zod/v4';
import { MailConnectorOperation } from '../integrations/mail-connector.js';
import { mailTransaction, validateScope } from './reading.js';
import { MailArchiveError, type MailSourceKey, type MailConsumerScope, type MailSource } from './types.js';
import type { MailTransport } from './transport.js';
import { NEWSLETTER_POLICY_LIMITS } from './policy.js';
export const MAIL_CONNECTOR_ACTIONS = ['get_profile', 'search', 'list_messages', 'list_history', 'get_metadata', 'get_message', 'get_message_summary', 'modify_message'] as const;
export const MAIL_USAGE_EVENTS = ['connectorCalls', 'messageRetrievals', 'reusedBodies', 'aiClassificationCalls', 'classificationReuse', ...MAIL_CONNECTOR_ACTIONS] as const;
export type MailUsageEvent = typeof MAIL_USAGE_EVENTS[number];
export type MailWorkerUsageEvent = 'reusedBodies' | 'aiClassificationCalls' | 'classificationReuse';
export interface MailUsageInput extends MailSourceKey {
    events: MailUsageEvent[];
}
const Events = z.array(z.enum(MAIL_USAGE_EVENTS)).min(1).max(MAIL_USAGE_EVENTS.length).refine(events => new Set(events).size === events.length);
/** Counters are observed service attempts/reuse, never a billing ledger. */
export async function recordMailUsage(db: Kysely<unknown>, input: MailUsageInput): Promise<void> {
    validateScope({ ...input, appId: 'edition' });
    const events = Events.parse(input.events).sort();
    await mailTransaction(db, async (trx) => {
        const grant = await sql `SELECT 1 FROM mail_consumer_grants WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND app_id='edition' AND NOT revoked FOR SHARE`.execute(trx);
        if (!grant.rows.length)
            throw new MailArchiveError('denied');
        // Stable event order avoids lock inversions; the transaction rolls back every
        // related counter if any counter reaches its exact safe integer bound.
        for (const event of events) {
            const updated = await sql `INSERT INTO mail_usage(owner_id,account_id,kind,count) VALUES(${input.ownerId},${input.accountId},${event},1)
   ON CONFLICT(owner_id,account_id,kind) DO UPDATE SET count=mail_usage.count+1 WHERE mail_usage.count<${Number.MAX_SAFE_INTEGER} RETURNING kind`.execute(trx);
            if (!updated.rows.length)
                throw new MailArchiveError('quota');
        }
    });
}
export async function getMailUsageSummary(db: Kysely<unknown>, input: MailConsumerScope) {
    validateScope(input);
    return mailTransaction(db, async (trx) => {
        const grant = (await sql<{
            range_from: Date | null;
            range_until: Date | null;
        }> `SELECT range_from,range_until FROM mail_consumer_grants WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND app_id=${input.appId} AND NOT revoked FOR SHARE`.execute(trx)).rows[0];
        if (!grant)
            throw new MailArchiveError('denied');
        // One bounded aggregate follows the same current fingerprint and model-policy
        // selection as the reader. No message bodies or provider IDs leave this query.
        const row = (await sql<{
            retained: string;
            partial: string;
            classified: string;
            review: string;
        }> `WITH scoped AS (
   SELECT m.object,m.correction,c.result,c.context_kind FROM mail_messages m
   LEFT JOIN LATERAL(SELECT result,context_kind FROM mail_classifications c WHERE c.owner_id=m.owner_id AND c.account_id=m.account_id AND c.message_id=m.message_id
    AND c.fingerprint=m.object->>'digest' AND c.recipe='email-triage-v1' ORDER BY c.model_policy_version DESC LIMIT 1)c ON true
   WHERE m.owner_id=${input.ownerId} AND m.account_id=${input.accountId} AND m.deleted_at IS NULL
    ${grant.range_from ? sql `AND m.received_at>=${grant.range_from}` : sql ``} ${grant.range_until ? sql `AND m.received_at<=${grant.range_until}` : sql ``}
  ), scores AS (SELECT s.*,p.newsletter,p.conflict FROM scoped s LEFT JOIN LATERAL(
   SELECT max((a->>'probability')::float8) FILTER(WHERE a->>'id'='newsletter') newsletter,
    bool_or((a->>'probability')::float8>${NEWSLETTER_POLICY_LIMITS.exclusion}) FILTER(WHERE a->>'id'<>'newsletter') conflict
   FROM jsonb_array_elements(s.result->'answers') a)p ON true)
   SELECT count(*) FILTER(WHERE object IS NOT NULL) retained,count(*) FILTER(WHERE object IS NULL) partial,
    count(*) FILTER(WHERE object IS NOT NULL AND result IS NOT NULL) classified,
    count(*) FILTER(WHERE correction IS NULL AND (object IS NULL OR result IS NULL OR
     (NOT(context_kind='verified' AND newsletter>=${NEWSLETTER_POLICY_LIMITS.confirmed} AND NOT conflict) AND (newsletter>=${NEWSLETTER_POLICY_LIMITS.review} OR conflict)))) review FROM scores`.execute(trx)).rows[0]!;
        const usage = (await sql<{
            kind: MailUsageEvent;
            count: string;
        }> `SELECT kind,count FROM mail_usage WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(trx)).rows;
        const counters = Object.fromEntries(MAIL_USAGE_EVENTS.map(kind => [kind, 0])) as Record<MailUsageEvent, number>;
        for (const entry of usage)
            counters[entry.kind] = Number(entry.count);
        return { retainedCount: Number(row.retained), partialCount: Number(row.partial), classifiedCount: Number(row.classified), reviewPendingCount: Number(row.review),
            observedScope: 'account_total' as const, observed: { connectorCalls: counters.connectorCalls, messageRetrievals: counters.messageRetrievals, reusedBodies: counters.reusedBodies, aiClassificationCalls: counters.aiClassificationCalls, classificationReuse: counters.classificationReuse, byAction: Object.fromEntries(MAIL_CONNECTOR_ACTIONS.map(action => [action, counters[action]])) }, billedUsage: null };
    });
}
/** Exact current Edition grants provide the scope for observed connector calls.
 * Initial connect profile verification precedes consent and is not counted. */
export function createObservedMailTransport(options: {
    transport: MailTransport;
    repository: {
        listGrantedSources(input: {
            ownerId: string;
            appId: string;
        }): Promise<MailSource[]>;
        recordUsage(input: MailUsageInput): Promise<void>;
    };
}): MailTransport {
    return { inventory: (...args) => options.transport.inventory(...args), async call(owner, binding, action, params, signal) {
            signal?.throwIfAborted();
            const operation = MailConnectorOperation.parse({ action, params });
            const source = (await options.repository.listGrantedSources({ ownerId: owner, appId: 'edition' })).find(source => source.connectionId === binding.connectionId && source.email === binding.expectedEmail && source.accountLabel === binding.accountLabel);
            if (source)
                await options.repository.recordUsage({ ...source, events: ['connectorCalls', operation.action, ...(operation.action === 'get_message' || operation.action === 'get_message_summary' ? ['messageRetrievals' as const] : [])] });
            else if (operation.action !== 'get_profile')
                throw new MailArchiveError('denied');
            signal?.throwIfAborted();
            return options.transport.call(owner, binding, operation.action, operation.params, signal);
        } };
}
