import { randomUUID } from "node:crypto";

const MAX_OWNERS = 512;
const MAX_ITEMS_PER_OWNER = 200;
const UNSAFE_DISPLAY = /(sk_[a-z0-9][a-z0-9_-]*|\/home\/[^\s,;]+|[A-Za-z0-9_.-]*(?:secret|token)[A-Za-z0-9_.-]*\s*[:=]\s*[^\s,;]+)/gi;
const SENSITIVE_TERMS = /\b(secret|token|postgres|database)\b/gi;

export type CompanyContextType =
  | "product_decision"
  | "customer_note"
  | "support_thread"
  | "growth_idea"
  | "social_draft"
  | "task"
  | "project_record";

export interface CompanyContextItem {
  id: string;
  type: CompanyContextType;
  title: string;
  summary: string;
  source: string;
  visibility: "owner_only" | "authorized_teammates";
  updatedAt: string;
}

export interface CompanyBrainReadiness {
  status: "needs_context" | "ready" | "needs_review";
  guidance: string;
  items: CompanyContextItem[];
  sourceLinks: string[];
  reviewFlags: Array<{
    itemId: string;
    kind: "stale" | "contradiction";
    message: string;
  }>;
}

export interface CompanyBrainReadinessService {
  getReadiness(ownerId: string): Promise<CompanyBrainReadiness>;
  addContext(ownerId: string, input: Omit<CompanyContextItem, "id" | "updatedAt">): Promise<CompanyContextItem>;
}

function safeDisplay(value: string, fallback: string, max = 220): string {
  const trimmed = value.trim().slice(0, max);
  if (!trimmed) return fallback;
  const redacted = trimmed
    .replace(UNSAFE_DISPLAY, "[redacted]")
    .replace(SENSITIVE_TERMS, "[redacted]")
    .trim();
  return redacted || fallback;
}

function flagsFor(item: CompanyContextItem): CompanyBrainReadiness["reviewFlags"] {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const flags: CompanyBrainReadiness["reviewFlags"] = [];
  if (text.includes("stale")) {
    flags.push({ itemId: item.id, kind: "stale", message: "Check whether this context is still current." });
  }
  if (/(^|[^a-z0-9-])contradict(?:ion|ions|ory|s|ed)?\b/.test(text)) {
    flags.push({ itemId: item.id, kind: "contradiction", message: "Resolve contradictory context before agents rely on it." });
  }
  return flags;
}

export function createCompanyBrainReadinessService(options: {
  now?: () => Date;
} = {}): CompanyBrainReadinessService {
  const now = options.now ?? (() => new Date());
  const ownerItems = new Map<string, CompanyContextItem[]>();

  function getItems(ownerId: string): CompanyContextItem[] {
    const existing = ownerItems.get(ownerId);
    if (existing) {
      ownerItems.delete(ownerId);
      ownerItems.set(ownerId, existing);
      return existing;
    }
    if (ownerItems.size >= MAX_OWNERS) {
      const oldestKey = ownerItems.keys().next().value as string | undefined;
      if (oldestKey) ownerItems.delete(oldestKey);
    }
    const next: CompanyContextItem[] = [];
    ownerItems.set(ownerId, next);
    return next;
  }

  async function getReadiness(ownerId: string): Promise<CompanyBrainReadiness> {
    const items = getItems(ownerId);
    const reviewFlags = items.flatMap(flagsFor);
    const status = items.length === 0 ? "needs_context" : reviewFlags.length > 0 ? "needs_review" : "ready";
    return {
      status,
      guidance: status === "needs_context"
        ? "Add a product decision, customer note, or project record so Matrix can ground company answers."
        : status === "needs_review"
          ? "Review stale or contradictory context before agents rely on it."
          : "Company context is ready for Matrix answers and drafts.",
      items: [...items],
      sourceLinks: Array.from(new Set(items.map((item) => item.source))).slice(0, 20),
      reviewFlags,
    };
  }

  async function addContext(ownerId: string, input: Omit<CompanyContextItem, "id" | "updatedAt">): Promise<CompanyContextItem> {
    const items = getItems(ownerId);
    const item: CompanyContextItem = {
      ...input,
      id: `ctx.${randomUUID()}`,
      title: safeDisplay(input.title, "Company context"),
      summary: safeDisplay(input.summary, "Company context captured", 800),
      source: safeDisplay(input.source, "Manual note"),
      updatedAt: now().toISOString(),
    };
    items.push(item);
    while (items.length > MAX_ITEMS_PER_OWNER) items.shift();
    return item;
  }

  return { getReadiness, addContext };
}
