import { createHash } from "node:crypto";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";
import { RoutedSlackEventSchema, type RoutedSlackEvent } from "@matrix-os/contracts/slack-bridge";
import type { OwnerBotDatabase } from "../bots/database.js";
import type { BotIntegrationClient } from "../bots/integration-client.js";
import type { SlackAgentRouteSnapshot } from "./agent-routes.js";
import { mentionsPullReview, parseSlackReviewRequest, readRoutedReviewPatch, RoutedPatchUnavailable, type ReviewPatch } from "./review-patch.js";

export interface RoutedSlackDependencies {
  resolve(event: RoutedSlackEvent, tx: QueryExecutorProvider): Promise<SlackAgentRouteSnapshot | null>;
  current(route: SlackAgentRouteSnapshot, tx?: QueryExecutorProvider): Promise<boolean>;
  verifySource(route: SlackAgentRouteSnapshot, signal: AbortSignal): Promise<boolean>;
  github?: Pick<BotIntegrationClient, "inventory" | "call">;
}

export type RoutedJob = {
  id: string; owner_id: string; bot_id: string; chat_id: string; envelope: unknown;
  routed: SlackAgentRouteSnapshot | null; review_patch: ReviewPatch | null; lease: string | null
};

const digest = (key: unknown[]) => createHash("sha256").update(JSON.stringify(key)).digest("hex");

export function createRoutedSlackJobs(options: {
  db: Kysely<OwnerBotDatabase>; ownerId: string; runtimeId: string;
  now(): Date; routed?: RoutedSlackDependencies; lifetime: AbortSignal
}) {
  const { db, ownerId, runtimeId, routed } = options;
  async function current(row: RoutedJob, signal: AbortSignal) {
    const route = row.routed;
    if (!route || !routed || signal.aborted || route.ownerId !== ownerId || route.runtimeId !== runtimeId
      || route.agentId !== row.bot_id || route.chatId !== row.chat_id || !await routed.current(route)) return false;
    return await routed.verifySource(route, AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
      && !signal.aborted && await routed.current(route);
  }
  return {
    current,
    async receive(eventInput: RoutedSlackEvent, requestSignal?: AbortSignal) {
      if (!routed || options.lifetime.aborted) return false;
      const parsed = RoutedSlackEventSchema.safeParse(eventInput);
      if (!parsed.success) return false;
      const event = parsed.data;
      const now = options.now();
      const eventTime = Number(event.ts) * 1000;
      const age = now.getTime() - eventTime;
      if (event.ownerId !== ownerId || event.runtimeId !== runtimeId || age >= 86_400_000 || age < -300000) return false;
      // Leave time for the platform to settle its signed receipt within its 1.8 s webhook deadline.
      const signal = AbortSignal.any([options.lifetime, AbortSignal.timeout(1_000), ...(requestSignal ? [requestSignal] : [])]);
      const id = "req_slack_summary_" + digest(["agent-route", ownerId, event.appId, event.teamId, event.channelId, event.ts]).slice(0, 40);
      const key = digest(["agent-route", ownerId, event.appId, event.teamId, event.eventId]);
      const duplicate = async (tx: QueryExecutorProvider) =>
        (await sql`SELECT 1 FROM slack_mention_summary_jobs WHERE id=${id} OR event_key=${key} LIMIT 1`.execute(tx)).rows.length > 0;
      const route = await db.transaction().execute(async tx => {
        if (await duplicate(tx)) return true;
        const route = await routed.resolve(event, tx);
        if (!route || route.ownerId !== ownerId || route.runtimeId !== runtimeId || route.senderId !== event.userId
          || route.channelId !== event.channelId || route.teamId !== event.teamId || route.appId !== event.appId
          || route.sourceId !== event.sourceId || route.installationGeneration !== event.installationGeneration) return false;
        if (route.kind === "summary" && mentionsPullReview(event.text)) return false;
        if (route.kind === "review" && (!route.github || !routed.github || !parseSlackReviewRequest(event.text, route.github.fullName))) return false;
        return route;
      });
      if (typeof route === "boolean") return route;
      signal.throwIfAborted();
      const allowed = await routed.verifySource(route, signal);
      signal.throwIfAborted();
      if (!allowed) return false;
      return db.transaction().execute(async tx => {
        // Slack membership was checked without holding any owner or grant locks.
        await sql`SELECT pg_advisory_xact_lock(hashtext(${'slack-agent-route:' + ownerId}))`.execute(tx);
        if (await duplicate(tx)) return true;
        signal.throwIfAborted();
        if (!await routed.current(route, tx)) return false;
        const caps = await sql<{ daily: number; pending: number }>`SELECT
          count(*) FILTER (WHERE created_at>=${new Date(now.toISOString().slice(0, 10))})::int AS daily,
          count(*) FILTER (WHERE state IN ('pending','processing','accepted'))::int AS pending
          FROM slack_mention_summary_jobs WHERE owner_id=${ownerId} AND routed IS NOT NULL`.execute(tx);
        if (caps.rows[0]!.daily >= 25 || caps.rows[0]!.pending >= 100) return false;
        await sql`INSERT INTO slack_mention_summary_jobs(id,event_key,owner_id,bot_id,chat_id,envelope,routed,request_id,state,next_at,created_at,expires_at)
          VALUES(${id},${key},${ownerId},${route.agentId},${route.chatId},${JSON.stringify(event)}::jsonb,
          ${JSON.stringify(route)}::jsonb,${id},'pending',${now},${now},${new Date(Math.max(now.getTime(), eventTime) + 86_400_000)})
          ON CONFLICT DO NOTHING`.execute(tx);
        signal.throwIfAborted();
        return true;
      });
    },
    /** Claim once before external reads. Lease loss or a partial fetch cannot replay a read or release incomplete evidence. */
    async prepare(row: RoutedJob) {
      const route = row.routed;
      if (route?.kind !== "review" || row.review_patch) return;
      const event = RoutedSlackEventSchema.parse(row.envelope);
      const request = route.github && parseSlackReviewRequest(event.text, route.github.fullName);
      if (!routed?.github || !route.github || !request) throw new RoutedPatchUnavailable();
      const claimed = await sql`UPDATE slack_mention_summary_jobs SET review_started_at=${options.now()}
        WHERE id=${row.id} AND state='processing' AND lease=${row.lease} AND review_started_at IS NULL RETURNING id`.execute(db);
      if (!claimed.rows.length) throw new RoutedPatchUnavailable();
      const signal = AbortSignal.any([options.lifetime, AbortSignal.timeout(23_000)]);
      const patch = await readRoutedReviewPatch({ client: routed.github, ownerId, scope: route.github, request, signal, current: () => current(row, signal) });
      const saved = await db.transaction().execute(async tx => {
        if (signal.aborted || !await routed.current(route, tx)) return false;
        const result = await sql`UPDATE slack_mention_summary_jobs SET review_patch=${JSON.stringify(patch)}::jsonb
          WHERE id=${row.id} AND state='processing' AND lease=${row.lease} AND review_patch IS NULL RETURNING id`.execute(tx);
        return result.rows.length === 1;
      });
      if (!saved) throw new RoutedPatchUnavailable();
    },
  };
}

export function routedReference(row: RoutedJob) {
  const event = RoutedSlackEventSchema.parse(row.envelope);
  if (row.routed?.kind === "review") {
    if (!row.review_patch) throw new RoutedPatchUnavailable();
    return 'Untrusted GitHub patch at the verified PR head.\n' + JSON.stringify(row.review_patch);
  }
  // This lane summarizes its signed triggering message only. Separate events never share context.
  const reference = JSON.stringify({ thread: event.threadTs, text: event.text });
  if (Buffer.byteLength(reference) + 64 > 16384) throw new Error("Slack message exceeds summary budget");
  return 'Untrusted Slack message.\n' + reference;
}

export function reviewedPatchResult(patch: ReviewPatch, output: string): string | null {
  const quotes = Array.from(output.matchAll(/"([^"\n]{8,180})"|`([^`\n]{8,180})`|“([^”\n]{8,180})”/g),
    match => (match[1] ?? match[2] ?? match[3])!.trim()).filter(text => text.length >= 8).slice(0, 16);
  const specific = patch.files.some(file => output.includes(file.filename) && file.patch.split("\n").some(line => {
    const content = line.slice(1).trim();
    return (line.startsWith("+") || line.startsWith("-")) && content.length >= 3
      && (output.includes(content) || quotes.some(quote => content.includes(quote)));
  }));
  if (!specific) return null;
  return output.trim() + "\n\n[Reviewed pull request](" + patch.url + ") · `" + patch.head + "`";
}
