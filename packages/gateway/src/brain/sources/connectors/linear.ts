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
