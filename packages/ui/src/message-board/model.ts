import type {
  BoardActor, BoardChannel, BoardTask, BoardTaskState, BoardThreadSummary,
} from "./types.js";

const CHANNEL_SEGMENT = /^[a-z0-9_-]{1,48}$/;
const LABEL_KEY = /^[a-z0-9_.-]{1,64}$/;
const RESERVED_LABEL_PREFIXES = ["board.", "matrix."] as const;
const MAX_LABEL_VALUE_BYTES = 256;

/** Spec 2700 input limits: at most 8 segments of 1 to 48 characters, 200 characters total. */
export function validateChannelPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  const segments = path.split("/");
  return segments.length <= 8 && segments.every((segment) => CHANNEL_SEGMENT.test(segment));
}

/** `dev` is exact, `security/` is that subtree (including `security` itself), `*` is every channel. */
export function channelInScope(scope: string, path: string): boolean {
  if (scope === "*") return true;
  if (!scope.endsWith("/")) return scope === path;
  const prefix = scope.slice(0, -1);
  return path === prefix || path.startsWith(scope);
}

export function channelScopeLabel(scope: string): string {
  return scope === "*" ? "All channels" : scope;
}

export interface ChannelTreeNode {
  segment: string;
  /** Full path without a trailing slash. */
  path: string;
  depth: number;
  /** The channel at exactly this path, when one exists. */
  channel: BoardChannel | null;
  children: ChannelTreeNode[];
  /** Unread threads in this channel and every descendant. */
  unread: number;
}

export function buildChannelTree(channels: readonly BoardChannel[]): ChannelTreeNode[] {
  const roots: ChannelTreeNode[] = [];
  for (const channel of channels) {
    let level = roots;
    let node: ChannelTreeNode | undefined;
    const segments = channel.path.split("/");
    segments.forEach((segment, depth) => {
      const path = segments.slice(0, depth + 1).join("/");
      node = level.find((candidate) => candidate.segment === segment);
      if (!node) {
        node = { segment, path, depth, channel: null, children: [], unread: 0 };
        level.push(node);
      }
      node.unread += channel.unread;
      level = node.children;
    });
    if (node) node.channel = channel;
  }
  const sortLevel = (nodes: ChannelTreeNode[]): ChannelTreeNode[] => {
    nodes.sort((left, right) => left.segment.localeCompare(right.segment));
    for (const node of nodes) sortLevel(node.children);
    return nodes;
  };
  return sortLevel(roots);
}

export interface LabelFilter {
  key: string;
  /** null matches any value. */
  values: string[] | null;
}

export function parseLabelFilter(input: string): LabelFilter | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf("=");
  const key = separator === -1 ? trimmed : trimmed.slice(0, separator);
  if (!LABEL_KEY.test(key)) return null;
  if (separator === -1) return { key, values: null };
  const values = trimmed.slice(separator + 1).split("|").map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? { key, values } : null;
}

/** A filter matches a message or its thread root, so labelling a root brings the whole thread into view. */
export function matchesLabelFilter(
  filter: LabelFilter,
  labels: Readonly<Record<string, string>>,
  rootLabels: Readonly<Record<string, string>> = {},
): boolean {
  return [labels, rootLabels].some((set) => {
    if (!Object.hasOwn(set, filter.key)) return false;
    return filter.values === null || filter.values.includes(set[filter.key]!);
  });
}

export function isReservedLabelKey(key: string): boolean {
  return RESERVED_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export type ParsedLabelInput = { ok: true; key: string; value: string } | { ok: false; reason: "format" | "reserved" };

export function parseLabelInput(input: string): ParsedLabelInput {
  const trimmed = input.trim();
  const separator = trimmed.indexOf("=");
  if (separator <= 0) return { ok: false, reason: "format" };
  const key = trimmed.slice(0, separator);
  const value = trimmed.slice(separator + 1).trim();
  if (!LABEL_KEY.test(key) || value.length === 0 || new TextEncoder().encode(value).length > MAX_LABEL_VALUE_BYTES) {
    return { ok: false, reason: "format" };
  }
  if (isReservedLabelKey(key)) return { ok: false, reason: "reserved" };
  return { ok: true, key, value };
}

export function sortThreadsByActivity(threads: readonly BoardThreadSummary[]): BoardThreadSummary[] {
  return [...threads].sort((left, right) => {
    const delta = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
    return delta !== 0 ? delta : right.root.id.localeCompare(left.root.id);
  });
}

/** Queue order: what an agent or person can act on first. */
export const TASK_QUEUE_ORDER: readonly BoardTaskState[] = ["ready", "claimed", "blocked", "waiting", "failed", "completed", "canceled"];

export const TASK_STATE_LABELS: Readonly<Record<BoardTaskState, string>> = {
  waiting: "Waiting", ready: "Ready", claimed: "Claimed", blocked: "Blocked",
  completed: "Completed", failed: "Failed", canceled: "Canceled",
};

export interface TaskGroup {
  state: BoardTaskState;
  threads: BoardThreadSummary[];
}

export function groupTasksByState(threads: readonly BoardThreadSummary[]): TaskGroup[] {
  const sorted = sortThreadsByActivity(threads.filter((thread) => thread.task !== null));
  return TASK_QUEUE_ORDER
    .map((state) => ({ state, threads: sorted.filter((thread) => thread.task!.state === state) }))
    .filter((group) => group.threads.length > 0);
}

/** `m:ss` (or `h:mm:ss`) until the lease lapses, rounded up; `expired` once past. */
export function formatLeaseCountdown(leaseUntil: string | null, nowMs: number): string | null {
  if (!leaseUntil) return null;
  const until = Date.parse(leaseUntil);
  if (Number.isNaN(until)) return null;
  const remaining = Math.ceil((until - nowMs) / 1000);
  if (remaining <= 0) return "expired";
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = String(remaining % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export interface MentionQuery {
  start: number;
  query: string;
}

const MENTION_CHARS = /^[a-z0-9_.-]*$/i;

export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  return MENTION_CHARS.test(query) ? { start: at, query } : null;
}

export function insertMention(text: string, mention: MentionQuery, handle: string): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length;
  const rest = text.slice(end);
  const inserted = `@${handle}${rest.startsWith(" ") ? "" : " "}`;
  const next = `${text.slice(0, mention.start)}${inserted}${rest}`;
  return { text: next, caret: mention.start + inserted.length + (rest.startsWith(" ") ? 1 : 0) };
}

/** The name a mention resolves to: the profile for agents, else the display name. */
export function mentionHandle(actor: BoardActor): string {
  return (actor.profile ?? actor.name).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}

export type PersonTaskAction = "claim" | "complete" | "release" | "assign" | "block" | "unblock" | "reopen" | "cancel";

export function availableTaskActions(task: BoardTask, viewerId: string): PersonTaskAction[] {
  switch (task.state) {
    case "ready": return ["claim", "assign", "block", "cancel"];
    case "waiting": return ["assign", "cancel"];
    case "claimed": return task.holder?.id === viewerId ? ["complete", "release", "block", "cancel"] : ["cancel"];
    case "blocked": return ["unblock", "cancel"];
    case "failed":
    case "completed":
    case "canceled": return ["reopen"];
  }
}

export function actorLabel(actor: BoardActor, viewerId?: string): string {
  if (actor.id === viewerId) return "You";
  return actor.profile ? `${actor.profile} via ${actor.name}` : actor.name;
}

export function threadTitle(text: string, deleted: boolean): string {
  if (deleted) return "Deleted message";
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstLine.replace(/^#+\s*/, "").trim() || "Untitled";
}
