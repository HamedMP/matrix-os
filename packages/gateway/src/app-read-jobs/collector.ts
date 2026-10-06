import { z } from "zod/v4";
import type { AppIntegrationInput } from "@matrix-os/contracts";
import { getAction } from "../integrations/registry.js";
import { validateActionParams } from "../integrations/parameter-validation.js";
import type { JsonValue, ReadJob, ReadJobSnapshot, ReadSource, SafeReadError } from "./types.js";

export type ReadRequest = AppIntegrationInput & { ownerId: string; app: string };
export type ScopedRead = (input: ReadRequest, signal: AbortSignal) => Promise<{data: unknown}>;
export function safeReadError(error: unknown): SafeReadError {
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return "timeout";
  const code = error instanceof Error && "code" in error ? error.code : null;
  return ["denied", "invalid", "unavailable", "busy", "timeout", "budget"].includes(String(code)) ? code as SafeReadError : "unavailable";
}
const fields = new Set("id number identifier title body description url html_url updated_at updatedAt created_at createdAt merged_at closed_at dueDate draft state status mergeable mergeable_state author user login name displayName assignee priority head sha ref repo full_name requested_reviewers requested_teams commit_id submitted_at conclusion completed_at started_at details_url head_sha check_runs total_count statuses context target_url team key project slugId labels nodes data issues pageInfo hasNextPage endCursor attachments relations messages text ts thread_ts reply_count permalink response_metadata next_cursor has_more ok error count next results channel content message_type author_type author_name is_private message_count last_message_text channel_source channel_detail slack_channel_id slack_thread_ts github_repo github_issue_number email_subject ai_resolved escalation_reason ticket_number severity assignment assignee_id latest_message unread_message_count last_message_at".split(" "));
function project(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value.slice(0, 1600);
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0,100).map(item => project(item,depth+1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)).slice(0,40).map(([key,item]) => [key,project(item,depth+1)]));
  return null;
}
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const roots = { github: "list_prs", linear: "list_issues", slack: "list_messages", posthog: "list_tickets" } as const;
function rows(source: ReadSource, data: unknown): Record<string, any>[] {
  const obj = object(data);
  const list = source.service === "github" ? data : source.service === "linear" ? (obj.data?.issues?.nodes ?? obj.issues?.nodes) : source.service === "slack" ? obj.messages : obj.results;
  if (!Array.isArray(list)) throw new Error("Invalid source page");
  return list.filter(item => item && typeof item === "object" && !Array.isArray(item));
}
export async function collectReadJob(options: { job: ReadJob; ownerId: string; read: ScopedRead; signal: AbortSignal; previous?: ReadJobSnapshot[] }) {
  let calls = 0;
  const requests: ReadRequest[] = [];
  const snapshots: ReadJobSnapshot[] = [];
  for (const source of options.job.sources) {
    const previous = options.previous?.find(item => item.sourceKey === source.id && item.service === source.service && JSON.stringify(item.scope) === JSON.stringify(source.params));
    const snapshot: ReadJobSnapshot = { sourceKey:source.id,service:source.service,scope:source.params,coverage:"complete",observedAt:new Date().toISOString(),lastSuccessAt:previous?.lastSuccessAt ?? null,records:[] };
    async function call(action: string, params: AppIntegrationInput["params"]): Promise<unknown> {
      options.signal.throwIfAborted();
      if (calls >= 48) throw Object.assign(new Error("Read budget reached"),{code:"budget"});
      const definition = getAction(source.service,action);
      if (definition?.risk !== "read" || !validateActionParams(definition,params).valid) throw Object.assign(new Error("Invalid read"),{code:"invalid"});
      const request = { ownerId:options.ownerId,app:options.job.app,service:source.service,action,connectionId:source.connectionId,label:source.label,params };
      calls++;
      const response = await options.read(request,options.signal);
      requests.push(request);
      const raw = response.data;
      if (source.service === "slack" && object(raw).ok === false || source.service === "linear" && object(raw).errors) throw Object.assign(new Error("Source read failed"),{code:"unavailable"});
      const record = {action,params,data:project(raw)};
      if (Buffer.byteLength(JSON.stringify([...snapshot.records,record])) > 24576) throw Object.assign(new Error("Snapshot budget reached"),{code:"budget"});
      snapshot.records.push(record);
      return raw;
    }
    try {
      const entities: Record<string, any>[] = [];
      let cursor: string | undefined;
      for (let page=1;page<=2;page++) {
        const params: AppIntegrationInput["params"] = { ...source.params };
        if (source.service === "github") Object.assign(params,{state:"all",page,per_page:30});
        else if (source.service === "linear") Object.assign(params,{first:30,...cursor ? {after:cursor} : {}});
        else if (source.service === "slack") Object.assign(params,{limit:15,...cursor ? {cursor} : {}});
        else Object.assign(params,{limit:50,offset:(page-1)*50});
        const raw = await call(roots[source.service],params);
        const items = rows(source,raw); entities.push(...items);
        const obj = object(raw);
        const paging = source.service === "linear" ? (obj.data?.issues?.pageInfo ?? obj.issues?.pageInfo) : obj.response_metadata;
        const next = source.service === "github" ? items.length === 30 : source.service === "linear" ? paging?.hasNextPage === true : source.service === "slack" ? Boolean(paging?.next_cursor) || obj.has_more === true : Boolean(obj.next);
        if (!next) break;
        cursor = source.service === "linear" ? paging?.endCursor : paging?.next_cursor;
        if ((source.service === "linear" || source.service === "slack") && (typeof cursor !== "string" || !cursor)) throw new Error("Incomplete source cursor");
        if (page===2) {snapshot.coverage="partial";snapshot.error="budget";}
      }
      const enriched = entities.slice(0,4);
      if (entities.length>4 && source.service!=="linear") {snapshot.coverage="partial";snapshot.error="budget";}
      for (const entity of enriched) {
        if (source.service === "github") {
          if (!Number.isSafeInteger(entity.number) || entity.number<1) throw new Error("Invalid PR identifier");
          const pr = object(await call("get_pr",{...source.params,pull_number:entity.number}));
          const reviews=await call("list_pr_reviews",{...source.params,pull_number:entity.number,page:1,per_page:30});
          if(Array.isArray(reviews)&&reviews.length>=30){snapshot.coverage="partial";snapshot.error="budget";}
          const sha = pr.head?.sha;
          if (!z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/).safeParse(sha).success) throw new Error("Missing immutable PR head");
          const checks = object(await call("list_check_runs",{...source.params,sha,page:1,per_page:100}));
          const status = object(await call("get_combined_status",{...source.params,sha,page:1,per_page:100}));
          if (checks.total_count>100 || status.total_count>100) {snapshot.coverage="partial";snapshot.error="budget";}
        } else if (source.service === "slack" && entity.reply_count>0) {
          const thread = object(await call("list_thread_replies",{...source.params,ts:entity.thread_ts ?? entity.ts,limit:15}));
          if (thread.has_more || thread.response_metadata?.next_cursor) {snapshot.coverage="partial";snapshot.error="budget";}
        } else if (source.service === "posthog") {
          const id = z.uuid().parse(entity.id);
          await call("get_ticket",{...source.params,ticketId:id});
          const messages = object(await call("list_ticket_messages",{...source.params,ticketId:id,limit:50,offset:0}));
          if (messages.next) {snapshot.coverage="partial";snapshot.error="budget";}
        }
      }
      if (snapshot.coverage==="complete") snapshot.lastSuccessAt=snapshot.observedAt;
    } catch (error) {
      snapshot.coverage=snapshot.records.length ? "partial" : "unavailable";
      snapshot.error=safeReadError(error);
      if (previous) snapshot.records=previous.records;
    }
    snapshots.push(snapshot);
  }
  return { snapshots, requests, calls };
}
