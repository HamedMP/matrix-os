import type {
  CleanupOperation,
  CleanupPlan,
  CleanupReceipt,
  EditionMessage,
  EditionSource,
} from "./types";
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Edition data unavailable");
  return raw as Record<string, unknown>;
}
function text(raw: unknown, max = 512): string {
  if (typeof raw !== "string" || raw.length > max)
    throw new Error("Edition data unavailable");
  return raw;
}
export function parseMessage(raw: unknown): EditionMessage {
  const r = record(raw);
  if (r.partial !== undefined && typeof r.partial !== "boolean")
    throw new Error("Edition data unavailable");
  if (
    !["newsletter", "review", "other"].includes(String(r.classification)) ||
    typeof r.saved !== "boolean" ||
    typeof r.read !== "boolean" ||
    typeof r.progress !== "number" ||
    !Number.isFinite(r.progress) ||
    r.progress < 0 ||
    r.progress > 1 ||
    !Number.isSafeInteger(r.revision) ||
    Number(r.revision) < 0 ||
    !Number.isSafeInteger(r.readingRevision) ||
    Number(r.readingRevision) < 0
  )
    throw new Error("Edition data unavailable");
  return {
    id: text(r.id),
    sourceId: text(r.sourceId),
    subject: text(r.subject, 1000),
    sender: text(r.sender, 1000),
    publication: text(r.publication, 1000),
    receivedAt: text(r.receivedAt, 100),
    excerpt: text(r.excerpt, 8192),
    ...(r.text === undefined ? {} : { text: text(r.text, 2 * 1024 * 1024) }),
    contentVersion: text(r.contentVersion),
    ...(r.partial === undefined ? {} : { partial: r.partial as boolean }),
    classification: r.classification as EditionMessage["classification"],
    saved: r.saved,
    read: r.read,
    progress: r.progress,
    revision: Number(r.revision),
    readingRevision: Number(r.readingRevision),
  };
}
export function parseMessages(raw: unknown): {
  messages: EditionMessage[];
  nextCursor?: string;
} {
  const r = record(raw);
  if (!Array.isArray(r.messages) || r.messages.length > 500)
    throw new Error("Edition data unavailable");
  return {
    messages: r.messages.map(parseMessage),
    ...(r.nextCursor ? { nextCursor: text(r.nextCursor) } : {}),
  };
}
export function parseSources(raw: unknown): {
  sources: EditionSource[];
  cacheScope?: string;
} {
  const r = record(raw);
  if (!Array.isArray(r.sources) || r.sources.length > 100)
    throw new Error("Reading sources unavailable");
  return {
    sources: r.sources.map((v) => {
      const s = record(v);
      if (s.scope !== "work" && s.scope !== "personal")
        throw new Error("Reading source unavailable");
      return {
        id: text(s.id),
        connectionId: text(s.connectionId),
        email: text(s.email, 320),
        label: text(s.label, 320),
        scope: s.scope,
        state: text(s.state, 100),
        ...sourceProgress(s),
        ...(s.coverageStart
          ? { coverageStart: text(s.coverageStart, 100) }
          : {}),
        ...(s.lastSyncedAt ? { lastSyncedAt: text(s.lastSyncedAt, 100) } : {}),
      };
    }),
    ...(r.cacheScope ? { cacheScope: text(r.cacheScope) } : {}),
  };
}
export function parsePlan(raw: unknown): CleanupPlan {
  const r = record(raw);
  if (
    !Number.isSafeInteger(r.revision) ||
    !Array.isArray(r.messageIds) ||
    r.messageIds.length < 1 ||
    r.messageIds.length > 100 ||
    new Set(r.messageIds).size !== r.messageIds.length
  )
    throw new Error("Cleanup plan unavailable");
  const expiresAt = text(r.expiresAt, 100);
  if (!Number.isFinite(new Date(expiresAt).getTime()))
    throw new Error("Cleanup plan unavailable");
  return {
    id: text(r.id),
    revision: Number(r.revision),
    messageIds: r.messageIds.map((id) => text(id)),
    expiresAt,
  };
}
export function parseReceipt(raw: unknown): CleanupReceipt {
  const r = record(raw);
  if (
    !["completed", "undone", "partial", "needs_verification"].includes(
      String(r.state),
    )
  )
    throw new Error("Cleanup receipt unavailable");
  for (const key of ["archivedCount", "restoredCount"])
    if (
      r[key] !== undefined &&
      (!Number.isSafeInteger(r[key]) ||
        Number(r[key]) < 0 ||
        Number(r[key]) > 100)
    )
      throw new Error("Cleanup receipt unavailable");
  return {
    id: text(r.id),
    state: r.state as CleanupReceipt["state"],
    ...(r.archivedCount === undefined
      ? {}
      : { archivedCount: Number(r.archivedCount) }),
    ...(r.restoredCount === undefined
      ? {}
      : { restoredCount: Number(r.restoredCount) }),
  };
}

export function parseCleanupRecovery(raw: unknown): CleanupOperation[] {
  const r = record(raw);
  if (!Array.isArray(r.operations) || r.operations.length > 20)
    throw new Error("Cleanup history unavailable");
  const operations = r.operations.map((v) => {
    const entry = record(v);
    return {
      plan: parsePlan(entry.plan),
      receipt: parseReceipt(entry.receipt),
    };
  });
  if (new Set(operations.map((op) => op.receipt.id)).size !== operations.length)
    throw new Error("Cleanup history unavailable");
  return operations;
}

function sourceProgress(s: Record<string, unknown>): Partial<EditionSource> {
  const progress: Partial<EditionSource> = {};
  if (s.sharedWith !== undefined) {
    if (
      !Array.isArray(s.sharedWith) ||
      s.sharedWith.length > 2 ||
      new Set(s.sharedWith).size !== s.sharedWith.length ||
      s.sharedWith.some((app) => app !== "folio" && app !== "atlas")
    )
      throw new Error("Consumer sharing unavailable");
    progress.sharedWith = s.sharedWith as ("folio" | "atlas")[];
  }
  for (const field of [
    "usedBytes",
    "quotaBytes",
    "retainedCount",
    "classifiedCount",
    "reviewPendingCount",
    "partialCount",
  ] as const) {
    if (s[field] === undefined) continue;
    if (!Number.isSafeInteger(s[field]) || Number(s[field]) < 0)
      throw new Error("Source progress unavailable");
    progress[field] = Number(s[field]);
  }
  if (s.availability !== undefined) {
    if (
      !["connected", "disconnected", "unknown"].includes(String(s.availability))
    )
      throw new Error("Source availability unavailable");
    progress.availability = s.availability as EditionSource["availability"];
  }
  if (s.observed !== undefined) {
    if (s.observedScope !== "account_total" || s.billedUsage !== null)
      throw new Error("Observed activity unavailable");
    const o = record(s.observed),
      count = (key: string) => {
        if (!Number.isSafeInteger(o[key]) || Number(o[key]) < 0)
          throw new Error("Observed activity unavailable");
        return Number(o[key]);
      };
    progress.observedScope = "account_total";
    progress.billedUsage = null;
    progress.observed = {
      connectorCalls: count("connectorCalls"),
      messageRetrievals: count("messageRetrievals"),
      reusedBodies: count("reusedBodies"),
      aiClassificationCalls: count("aiClassificationCalls"),
      classificationReuse: count("classificationReuse"),
    };
  }
  if (s.syncError !== undefined) {
    if (s.syncError !== "sync_unavailable")
      throw new Error("Source sync status unavailable");
    progress.syncError = "sync_unavailable";
  }
  for (const field of ["coverageEnd", "failureAt"] as const)
    if (s[field]) progress[field] = text(s[field], 100);
  return progress;
}
