/**
 * Linear source: issues, comments and project updates of the configured teams, read through the integration layer
 * (registry actions linear.brain_issues, linear.brain_comments, linear.brain_project_updates). Each phase is a
 * watermark pass over updatedAt >= since with GraphQL cursor paging; the first pass reads 365 days back. Archived or
 * trashed items become deletions.
 *
 * Cursor "lin1:" + base64url JSON: { v: 1, f: config fingerprint, w: per-phase watermark, p: the pass in progress
 * (phase, provider cursor, newest updatedAt seen, since) or null }. A different fingerprint starts over.
 */
import { z } from "zod/v4";
import {
  BRAIN_ISSUE_KEY_PATTERN, type BrainLinearSourceConfig, type BrainSourceAdapter, type BrainSourceNotice,
  type BrainSourceReadContext, type BrainSourceReadResult,
} from "../../contracts.js";
import { BRAIN_KIND_PATTERN, type BrainSyncUpsertInput } from "../../types.js";
import { callProvider, text, type ProviderCall, type ProviderCallContext } from "./provider.js";
import {
  RefSet, canonicalPermalink, clampTitle, composeBody, connectorDocumentId, decodeCursor, encodeCursor, isoInstant,
  personKey, shortHash,
} from "./text.js";
import { BRAIN_CONNECTOR_LIMITS } from "./types.js";

const PHASES = ["issues", "comments", "updates"] as const;
type Phase = (typeof PHASES)[number];
const PHASE_ACTIONS = { issues: "brain_issues", comments: "brain_comments", updates: "brain_project_updates" } as const;
const PHASE_FIELDS = { issues: "issues", comments: "comments", updates: "projectUpdates" } as const;
const RENDER_VERSION = "1";
const DAY_MS = 86_400_000;
/** Most refs one Linear document carries: an issue's handle, issue, author, assignee, status, due and 20 labels. */
const REFS_PER_ITEM_MAX = 26;

const id = z.string().min(1).max(128);
const instant = z.string().max(64).refine((value) => isoInstant(value) !== null);
const person = z.object({ id }).nullable().optional();
const archived = { archivedAt: instant.nullable().optional(), trashed: z.boolean().nullable().optional() };

const IssueSchema = z.object({
  id, identifier: text(32), title: text(4_000), description: text(1_000_000).nullable().optional(),
  url: text(2_048).nullable().optional(), updatedAt: instant, dueDate: text(32).nullable().optional(),
  priority: z.number().nullable().optional(), creator: person, assignee: person,
  state: z.object({ name: text(200), type: text(64) }).nullable().optional(),
  labels: z.object({ nodes: z.array(z.object({ name: text(200) })).max(250) }).nullable().optional(),
  project: z.object({ name: text(500) }).nullable().optional(),
  ...archived,
});
const CommentSchema = z.object({
  id, body: text(1_000_000), url: text(2_048).nullable().optional(), updatedAt: instant, user: person,
  issue: z.object({ id, identifier: text(32), title: text(4_000) }).nullable().optional(),
  ...archived,
});
const UpdateSchema = z.object({
  id, body: text(1_000_000), url: text(2_048).nullable().optional(), updatedAt: instant, user: person,
  health: text(64).nullable().optional(), project: z.object({ id, name: text(500) }).nullable().optional(),
  ...archived,
});
type Issue = z.output<typeof IssueSchema>;
type Comment = z.output<typeof CommentSchema>;
type Update = z.output<typeof UpdateSchema>;

function connection<T extends z.ZodType>(node: T) {
  return z.object({
    nodes: z.array(node).max(BRAIN_CONNECTOR_LIMITS.linearPageSize),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: text(512).nullable().optional() }),
  }).optional();
}
/** GraphQL `{ data: { <field>: { nodes, pageInfo } } }`; the field of the requested phase must be present. */
const ResponseSchema = z.object({
  data: z.object({ issues: connection(IssueSchema), comments: connection(CommentSchema), projectUpdates: connection(UpdateSchema) }),
});

const CursorSchema = z.object({
  v: z.literal(1), f: z.string().max(64),
  w: z.object({ issues: instant.optional(), comments: instant.optional(), updates: instant.optional() }).strict(),
  p: z.object({ k: z.enum(PHASES), a: text(512).nullable(), m: instant.nullable(), s: instant }).strict().nullable(),
}).strict();
type LinearCursor = z.output<typeof CursorSchema>;

/** Linear workflow state types to the shared status words. */
const STATUS_BY_STATE_TYPE: Readonly<Record<string, string>> = {
  triage: "open", backlog: "open", unstarted: "open", started: "in_progress", completed: "done", canceled: "canceled",
};

function phasesOf(config: BrainLinearSourceConfig): Phase[] {
  return PHASES.filter((phase) => config.include[PHASE_FIELDS[phase]]);
}

export function linearFingerprint(config: BrainLinearSourceConfig): string {
  return shortHash([RENDER_VERSION, ...[...config.teamKeys].sort(), ...phasesOf(config)]);
}

function snakeStatus(raw: string | null | undefined): string | null {
  const value = (raw ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return BRAIN_KIND_PATTERN.test(value) ? value : null;
}

const issueKey = (identifier: string) => BRAIN_ISSUE_KEY_PATTERN.test(identifier) ? identifier : null;

export function linearIssueDocumentId(externalRef: string, issueId: string): string {
  return connectorDocumentId("linear", externalRef, ["issue", issueId]);
}

function document(
  title: string, main: string, footer: string[], fields: Omit<BrainSyncUpsertInput, "title" | "body">,
): { upsert: BrainSyncUpsertInput; truncated: boolean } {
  const composed = composeBody(title, main, footer);
  return { upsert: { ...fields, title, body: composed.body }, truncated: composed.truncated };
}

function issueDocument(externalRef: string, issue: Issue) {
  const key = issueKey(issue.identifier);
  const title = clampTitle(key === null ? issue.title : `${key}: ${issue.title}`, "Linear issue");
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name);
  const status = STATUS_BY_STATE_TYPE[issue.state?.type ?? ""] ?? null;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(issue.dueDate ?? "") ? issue.dueDate! : null;
  const footer = [
    `Linear issue: ${key ?? issue.id}`,
    ...(issue.state ? [`State: ${issue.state.name}`] : []),
    ...(issue.project ? [`Project: ${issue.project.name}`] : []),
    ...(labels.length > 0 ? [`Labels: ${labels.slice(0, 20).join(", ")}`] : []),
    ...(due !== null ? [`Due: ${due}`] : []),
  ];
  const refs = new RefSet().add("handle", key).add("issue", key)
    .add("author", personKey("linear", issue.creator?.id)).add("assignee", personKey("linear", issue.assignee?.id))
    .add("status", status).add("due", due);
  for (const label of labels) refs.add("label", clampTitle(label, "", 100));
  return document(title, issue.description ?? "", footer, {
    documentId: linearIssueDocumentId(externalRef, issue.id), permalink: canonicalPermalink(issue.url),
    sourceUpdatedAt: isoInstant(issue.updatedAt)!, provenance: "linear_issue", refs: refs.list(),
  });
}

function commentDocument(externalRef: string, comment: Comment) {
  const key = comment.issue ? issueKey(comment.issue.identifier) : null;
  const title = clampTitle(comment.issue ? `Comment on ${key ?? "issue"}: ${comment.issue.title}` : "", "Linear comment");
  const refs = new RefSet().add("issue", key).add("author", personKey("linear", comment.user?.id))
    .add("parent", comment.issue ? linearIssueDocumentId(externalRef, comment.issue.id) : null);
  return document(title, comment.body, [`Linear comment on: ${key ?? "an issue"}`], {
    documentId: connectorDocumentId("linear", externalRef, ["comment", comment.id]),
    permalink: canonicalPermalink(comment.url), sourceUpdatedAt: isoInstant(comment.updatedAt)!,
    provenance: "linear_comment", refs: refs.list(),
  });
}

function updateDocument(externalRef: string, update: Update) {
  const name = update.project?.name ?? "";
  const title = clampTitle(name === "" ? "" : `Project update: ${name}`, "Linear project update");
  const footer = [`Linear project: ${clampTitle(name, "unknown")}`, ...(update.health ? [`Health: ${update.health}`] : [])];
  const refs = new RefSet().add("author", personKey("linear", update.user?.id)).add("status", snakeStatus(update.health));
  return document(title, update.body, footer, {
    documentId: connectorDocumentId("linear", externalRef, ["project_update", update.id]),
    permalink: canonicalPermalink(update.url), sourceUpdatedAt: isoInstant(update.updatedAt)!,
    provenance: "linear_update", refs: refs.list(),
  });
}

function startCursor(config: BrainLinearSourceConfig, context: BrainSourceReadContext<BrainLinearSourceConfig>):
  LinearCursor {
  const decoded = decodeCursor("lin1", context.cursor, CursorSchema);
  const fingerprint = linearFingerprint(config);
  return decoded !== null && decoded.f === fingerprint ? decoded : { v: 1, f: fingerprint, w: {}, p: null };
}

function documentsOf(phase: Phase, externalRef: string, node: Issue | Comment | Update) {
  if (phase === "issues") return issueDocument(externalRef, node as Issue);
  return phase === "comments" ? commentDocument(externalRef, node as Comment) : updateDocument(externalRef, node as Update);
}

async function readLinearPage(
  call: ProviderCallContext, context: BrainSourceReadContext<BrainLinearSourceConfig>,
): Promise<BrainSourceReadResult> {
  const { config } = context;
  const label = config.accountLabel;
  const phases = phasesOf(config);
  const cursor = startCursor(config, context);
  const notices: BrainSourceNotice[] = [];
  const phase = cursor.p?.k ?? phases[0]!;
  const windowStart = new Date(context.now().getTime() - BRAIN_CONNECTOR_LIMITS.linearHistoryDays * DAY_MS).toISOString();
  const since = cursor.p?.s ?? cursor.w[phase] ?? windowStart;
  if (cursor.w[phase] === undefined && (cursor.p?.a ?? null) === null) notices.push("history_window_limited");
  const response = await callProvider(call, {
    service: "linear", action: PHASE_ACTIONS[phase], ...(label === undefined ? {} : { label }),
    params: {
      teamKeys: [...config.teamKeys], updatedSince: since, after: cursor.p?.a ?? null,
      first: Math.max(1, Math.min(context.limits.maxUpserts, BRAIN_CONNECTOR_LIMITS.linearPageSize,
        Math.floor(context.limits.maxRefs / REFS_PER_ITEM_MAX))),
    },
  }, ResponseSchema);
  if (!response.ok) return response;
  const page = response.value.data[PHASE_FIELDS[phase]];
  if (page === undefined) return { ok: false, code: "provider_output_invalid" };
  const upserts = new Map<string, BrainSyncUpsertInput>();
  const deletions = new Set<string>();
  let newest = cursor.p?.m ?? null;
  for (const node of page.nodes) {
    const built = documentsOf(phase, context.externalRef, node);
    const stamp = built.upsert.sourceUpdatedAt;
    if (newest === null || stamp > newest) newest = stamp;
    if ((node.archivedAt ?? null) !== null || node.trashed === true) {
      upserts.delete(built.upsert.documentId);
      deletions.add(built.upsert.documentId);
      continue;
    }
    deletions.delete(built.upsert.documentId);
    upserts.set(built.upsert.documentId, built.upsert);
    if (built.truncated) notices.push("body_truncated");
  }
  const endCursor = page.pageInfo.endCursor ?? null;
  if (page.pageInfo.hasNextPage && endCursor === null) return { ok: false, code: "provider_output_invalid" };
  let next: LinearCursor;
  if (page.pageInfo.hasNextPage) {
    next = { ...cursor, p: { k: phase, a: endCursor, m: newest, s: since } };
  } else {
    const watermarks = { ...cursor.w, [phase]: newest ?? since };
    const following = phases[phases.indexOf(phase) + 1];
    const start = following === undefined ? null : { k: following, a: null, m: null, s: watermarks[following] ?? windowStart };
    next = { ...cursor, w: watermarks, p: start };
  }
  return {
    ok: true,
    page: {
      upserts: [...upserts.values()], deletions: [...deletions], nextCursor: encodeCursor("lin1", next),
      caughtUp: next.p === null, skipped: 0, notices: [...new Set(notices)],
    },
  };
}

export function createLinearAdapter(call: ProviderCall): BrainSourceAdapter<BrainLinearSourceConfig> {
  return { kind: "linear", readPage: (context) => readLinearPage({ ...call, signal: context.signal }, context) };
}
