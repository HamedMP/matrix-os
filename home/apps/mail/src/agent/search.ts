/**
 * Agentic mail search: hints from the question, parallel provider queries
 * with different strategies, a bounded read of the top candidates' bodies,
 * and a ranking with a one-line reason per thread.
 */
import { formatMailAddress, type MailThread, type ThreadSummary } from "../../../_shared/office-accounts/types/mail";
import { threadKey, type ThreadKey } from "../model/ids";
import type { MailStore } from "../model";
import { generateJson, type Validator } from "./ai";
import type { MailAgentContext } from "./context";
import { MailAgentError, throwIfAborted } from "./errors";
import {
  MAX_REASON_CHARS,
  MAX_SEARCH_BODIES_READ,
  MAX_SEARCH_CANDIDATES,
  MAX_SEARCH_RESULTS,
  SEARCH_BODY_BUDGET_CHARS,
} from "./limits";
import { buildPrompt, type PromptBlock } from "./prompt";
import {
  HINTS_SCHEMA,
  buildHintsPrompt,
  heuristicHints,
  mergeHints,
  planQueries,
  validateHints,
  type SearchHints,
  type SearchStrategy,
} from "./search-plan";
import { attachmentNames, messageText } from "./thread-blocks";
import { oneLineText } from "./untrusted";

export interface RankedThread {
  key: ThreadKey;
  accountId: string;
  threadId: string;
  subject: string;
  /** First participant, formatted. */
  from: string;
  lastMessageAt: string;
  /** One line, written by the model (or by the app when ranking failed). Render as text. */
  reason: string;
  strategies: SearchStrategy[];
}

export interface QueryOutcome {
  accountId: string;
  strategy: SearchStrategy;
  query: string;
  ok: boolean;
  count: number;
}

export interface AgenticSearchResult {
  hints: SearchHints;
  queries: QueryOutcome[];
  results: RankedThread[];
  /** False when the model could not rank and the app's own order is shown. */
  ranked: boolean;
}

export interface AgenticSearchOptions {
  signal?: AbortSignal;
  /** Progress lines for the panel. */
  onProgress?: (text: string) => void;
  /** `YYYY-MM-DD`, for relative dates. Defaults to the context clock. */
  today?: string;
}

interface Candidate {
  summary: ThreadSummary;
  strategies: Set<SearchStrategy>;
  score: number;
}

const STRATEGY_REASON: Record<SearchStrategy, string> = {
  sender_date: "the sender and dates",
  conversation: "the person and topic",
  topic: "the topic",
  subject: "the subject",
  attachment: "an attachment",
};

function fallbackReason(strategies: Iterable<SearchStrategy>): string {
  const parts = [...strategies].map((strategy) => STRATEGY_REASON[strategy]);
  return parts.length ? `Matches ${parts.join(", ")}.` : "Possible match.";
}

function toRanked(candidate: Candidate, reason: string): RankedThread {
  const s = candidate.summary;
  const first = s.participants[0];
  return {
    key: threadKey(s.accountId, s.id),
    accountId: s.accountId,
    threadId: s.id,
    subject: oneLineText(s.subject, 200),
    from: first ? oneLineText(formatMailAddress(first), 200) : "",
    lastMessageAt: s.lastMessageAt,
    reason: oneLineText(reason, MAX_REASON_CHARS),
    strategies: [...candidate.strategies],
  };
}

export const RANK_SCHEMA = '[{"candidate": number, "reason": string /* one short line: why it matches */}] /* best first, only real matches, at most 8; [] if none */';

export function rankValidator(count: number): Validator<Array<{ candidate: number; reason: string }>> {
  return (value) => {
    const list = Array.isArray(value) ? value : typeof value === "object" && value !== null && Array.isArray((value as { results?: unknown }).results) ? (value as { results: unknown[] }).results : null;
    if (!list) return null;
    const seen = new Set<number>();
    const ranked: Array<{ candidate: number; reason: string }> = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const n = (item as { candidate?: unknown }).candidate;
      const reason = (item as { reason?: unknown }).reason;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > count || seen.has(n)) continue;
      seen.add(n);
      ranked.push({ candidate: n, reason: typeof reason === "string" ? reason : "" });
      if (ranked.length >= MAX_SEARCH_RESULTS) break;
    }
    return ranked;
  };
}

/** One block per candidate; bodies share `SEARCH_BODY_BUDGET_CHARS`. */
export function candidateBlocks(candidates: readonly Candidate[], threads: ReadonlyMap<ThreadKey, MailThread>): PromptBlock[] {
  const perCandidate = Math.floor(SEARCH_BODY_BUDGET_CHARS / Math.max(1, candidates.length));
  return candidates.map((candidate, i) => {
    const s = candidate.summary;
    const thread = threads.get(threadKey(s.accountId, s.id));
    const sent = thread?.messages.filter((message) => !message.draftId) ?? [];
    const recent = sent.slice(-2);
    const body = recent.length
      ? recent.map((message) => `${formatMailAddress(message.from)}: ${messageText(message, Math.floor(perCandidate / recent.length))}`).join("\n\n")
      : s.snippet;
    return {
      label: `Candidate ${i + 1}`,
      from: s.participants.slice(0, 4).map(formatMailAddress).join(", "),
      date: s.lastMessageAt,
      subject: s.subject,
      attachments: sent.flatMap(attachmentNames).slice(0, 10),
      text: body.slice(0, perCandidate),
    };
  });
}

async function hintsFor(ctx: MailAgentContext, question: string, today: string, signal?: AbortSignal): Promise<SearchHints> {
  const heuristic = heuristicHints(question);
  try {
    const hints = await generateJson(ctx.ai, buildHintsPrompt(question, today), validateHints, HINTS_SCHEMA, { signal });
    return mergeHints(hints, heuristic);
  } catch (error: unknown) {
    if (error instanceof MailAgentError && error.code === "cancelled") throw error;
    ctx.log("search.hints.failed", error);
    return heuristic;
  }
}

function scoreOf(candidate: Candidate, hints: SearchHints, weights: Map<string, number>): number {
  let score = 0;
  for (const strategy of candidate.strategies) score += weights.get(strategy) ?? 1;
  if (hints.wantsAttachment && candidate.summary.hasAttachments) score += 0.5;
  const people = candidate.summary.participants.map((p) => `${p.name ?? ""} ${p.address}`.toLowerCase()).join(" ");
  if (hints.senders.some((sender) => people.includes(sender))) score += 1;
  const at = Date.parse(candidate.summary.lastMessageAt);
  return score + (Number.isFinite(at) ? at / 1e15 : 0);
}

export async function agenticSearch(ctx: MailAgentContext, question: string, options: AgenticSearchOptions = {}): Promise<AgenticSearchResult> {
  const { signal, onProgress } = options;
  const today = options.today ?? new Date(ctx.now()).toISOString().slice(0, 10);
  const accounts = ctx.store.getSnapshot().accounts.map((entry) => entry.account).filter((account) => ctx.providerFor(account.id));
  if (!accounts.length) throw new MailAgentError("no_account");

  onProgress?.("Working out what to look for");
  const hints = await hintsFor(ctx, question, today, signal);
  throwIfAborted(signal);

  const jobs = accounts.flatMap((account) => planQueries(hints, account.provider).map((plan) => ({ account, plan })));
  onProgress?.(`Searching with ${jobs.length} queries`);
  const settled = await Promise.allSettled(jobs.map(({ account, plan }) => ctx.providerFor(account.id)!.search(plan.query)));
  throwIfAborted(signal);

  const candidates = new Map<ThreadKey, Candidate>();
  const weights = new Map<string, number>();
  const queries: QueryOutcome[] = settled.map((result, i) => {
    const { account, plan } = jobs[i];
    weights.set(plan.strategy, Math.max(weights.get(plan.strategy) ?? 0, plan.weight));
    if (result.status !== "fulfilled") {
      ctx.log("search.query.failed", result.reason);
      return { accountId: account.id, strategy: plan.strategy, query: plan.query, ok: false, count: 0 };
    }
    for (const summary of result.value.items) {
      const key = threadKey(account.id, summary.id);
      const entry = candidates.get(key) ?? { summary: { ...summary, accountId: account.id }, strategies: new Set<SearchStrategy>(), score: 0 };
      entry.strategies.add(plan.strategy);
      candidates.set(key, entry);
    }
    return { accountId: account.id, strategy: plan.strategy, query: plan.query, ok: true, count: result.value.items.length };
  });
  if (jobs.length && queries.every((q) => !q.ok)) throw new MailAgentError("provider_failed");

  const ordered = [...candidates.values()]
    .map((candidate) => ({ ...candidate, score: scoreOf(candidate, hints, weights) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SEARCH_CANDIDATES);
  if (!ordered.length) return { hints, queries, results: [], ranked: true };

  const toRead = ordered.slice(0, MAX_SEARCH_BODIES_READ);
  onProgress?.(`Reading ${toRead.length} likely conversations`);
  const bodies = await Promise.allSettled(toRead.map((c) => ctx.providerFor(c.summary.accountId)!.getThread(c.summary.id)));
  throwIfAborted(signal);
  const threads = new Map<ThreadKey, MailThread>();
  bodies.forEach((result, i) => {
    if (result.status === "fulfilled") threads.set(threadKey(toRead[i].summary.accountId, toRead[i].summary.id), result.value);
    else ctx.log("search.read.failed", result.reason);
  });

  onProgress?.("Ranking what was found");
  const prompt = buildPrompt({
    task: "Pick the conversations that answer the owner's question and rank them, best first, with a one-line reason each.",
    schema: RANK_SCHEMA,
    rules: ["Judge only from the candidates' data. A reason names the concrete match (person, date, document, topic)."],
    instruction: question,
    blocks: candidateBlocks(toRead, threads),
  });
  try {
    const ranking = await generateJson(ctx.ai, prompt, rankValidator(toRead.length), RANK_SCHEMA, { signal });
    const results = ranking.map(({ candidate, reason }) => {
      const picked = toRead[candidate - 1];
      return toRanked(picked, reason.trim() || fallbackReason(picked.strategies));
    });
    return { hints, queries, results, ranked: true };
  } catch (error: unknown) {
    if (error instanceof MailAgentError && error.code === "cancelled") throw error;
    ctx.log("search.rank.failed", error);
    const results = ordered.slice(0, MAX_SEARCH_RESULTS).map((candidate) => toRanked(candidate, fallbackReason(candidate.strategies)));
    return { hints, queries, results, ranked: false };
  }
}

/**
 * Opens a search result in the reading pane. A thread the store has not
 * listed yet is brought in with a store search on its subject first.
 */
export async function openSearchResult(store: MailStore, result: RankedThread): Promise<boolean> {
  if (!store.getSnapshot().threads[result.key]) {
    const subject = result.subject.replace(/["\\]/g, " ").trim();
    if (!subject) return false;
    await store.search(`subject:"${subject}"`);
  }
  if (!store.getSnapshot().threads[result.key]) return false;
  await store.openThread(result.key);
  return true;
}
