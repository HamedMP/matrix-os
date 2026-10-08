/**
 * GitHub source adapter: one readPage call reads the repository's issue listing (issues and pull requests, oldest
 * update first, from the cursor's watermark) and maps up to a bounded number of items to documents. A page stops
 * early at its item, provider call, document, ref and time limits, or at the first provider failure (the items read
 * so far are still returned; the failure comes back on the next call that continues from that page, before any provider
 * call, so a retry never hides it or ignores its retryAfterSeconds). Each item moves the cursor only once its
 * documents are in the page, so a page's cursor never runs ahead of what it writes. A pull request too big for one
 * page stays open in the cursor and continues on the next page. Document ids use the source's stored external ref; a
 * config whose repository is another one is refused.
 */
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type {
  BrainGithubSourceConfig, BrainSourceAdapter, BrainSourceErrorCode, BrainSourceNotice, BrainSourcePageLimits,
  BrainSourceReadContext, BrainSourceReadResult,
} from "../../contracts.js";
import type { BrainDatabase, BrainSyncUpsertInput } from "../../index.js";
import { githubExternalRef, initialSince, toGithubTime } from "./config.js";
import { decodeGithubCursor, encodeGithubCursor, type BrainGithubCursor } from "./cursor.js";
import { githubConditionalRows } from "./database.js";
import { issueDocument, type GithubDocumentContext, type GithubUpsert } from "./documents.js";
import { pullRequestCalls, readPullRequest, type GithubItemDocuments } from "./pull-reader.js";
import { GithubIssueListSchema, type GithubIssue } from "./schemas.js";
import {
  GITHUB_LIMITS, type BrainGithubClient, type BrainGithubConditionalStore, type BrainGithubValidators,
} from "./types.js";

export interface BrainGithubAdapterDeps {
  readonly kysely: Kysely<BrainDatabase>;
  /** Called once per adapter; the store is only consulted by token-mode clients. */
  readonly createClient: (conditional: BrainGithubConditionalStore) => BrainGithubClient;
}

function hashCursor(cursor: string): string {
  return createHash("sha256").update(cursor, "utf8").digest("hex");
}

function fail(code: BrainSourceErrorCode, retryAfterSeconds?: number): BrainSourceReadResult {
  return retryAfterSeconds === undefined ? { ok: false, code } : { ok: false, code, retryAfterSeconds };
}

type GithubFailure = { readonly ok: false; readonly code: BrainSourceErrorCode; readonly retryAfterSeconds?: number };

/** What became of an item: all of it is in the page, only its first `written` children are, or none of it fit. */
type Added = { readonly done: true } | { readonly done: false; readonly written: number } | null;
const DONE: Added = { done: true };

function refCount(upserts: readonly GithubUpsert[]): number {
  return upserts.reduce((sum, upsert) => sum + upsert.refs.length, 0);
}

/** Documents, deletions and notices of one page, within the runner's limits. */
class PageCollector {
  readonly upserts: BrainSyncUpsertInput[] = [];
  readonly deletions: string[] = [];
  readonly notices: BrainSourceNotice[] = [];
  skipped = 0;
  private refs = 0;

  constructor(private readonly limits: BrainSourcePageLimits) {}

  get empty(): boolean {
    return this.upserts.length === 0 && this.deletions.length === 0;
  }

  notice(notice: BrainSourceNotice): void {
    if (!this.notices.includes(notice)) this.notices.push(notice);
  }

  /**
   * Adds an item's documents (its head, then its children from `skip` on) when they fit. An item alone in a page that
   * does not fit writes its head and the first children that fit, and stays open; its deletions wait for its last
   * page. One that cannot get further that way is cut to fit (items_truncated).
   */
  add(documents: GithubItemDocuments, skip: number): Added {
    const upserts = [...documents.upserts.slice(0, 1), ...documents.upserts.slice(1 + skip)];
    const fits = this.upserts.length + upserts.length <= this.limits.maxUpserts
      && this.deletions.length + documents.deletions.length <= this.limits.maxDeletions
      && this.refs + refCount(upserts) <= this.limits.maxRefs;
    if (fits) return this.take(documents, upserts, documents.deletions, DONE);
    if (!this.empty) return null;
    const kept: GithubUpsert[] = [];
    let budget = this.limits.maxRefs;
    for (const upsert of upserts) {
      if (kept.length >= this.limits.maxUpserts || upsert.refs.length > budget) break;
      kept.push(upsert);
      budget -= upsert.refs.length;
    }
    if (kept.length > 1 && kept.length < upserts.length) {
      return this.take(documents, kept, [], { done: false, written: skip + kept.length - 1 });
    }
    this.notice("items_truncated");
    const deletions = kept.length === upserts.length ? documents.deletions.slice(0, this.limits.maxDeletions) : [];
    return this.take(documents, kept, deletions, DONE);
  }

  private take(documents: GithubItemDocuments, upserts: readonly GithubUpsert[], deletions: readonly string[], added: Added): Added {
    this.upserts.push(...upserts);
    this.deletions.push(...deletions);
    this.refs += refCount(upserts);
    if (added !== null && added.done) this.skipped += documents.skipped;
    for (const notice of documents.notices) this.notice(notice);
    return added;
  }
}

/** Moves the watermark one second on; items tied at the old one that were not read yet are passed over. */
function skipSecond(cursor: BrainGithubCursor, page: PageCollector): BrainGithubCursor {
  page.notice("items_truncated");
  return { since: toGithubTime(Date.parse(cursor.since) + 1_000), page: 1, done: [] };
}

/** Cursor after applying an item (no item is open any more): a newer timestamp moves the watermark; a tie joins the done list. */
function advance(cursor: BrainGithubCursor, updatedAt: string, number: number, page: PageCollector): BrainGithubCursor {
  if (updatedAt > cursor.since) return { since: updatedAt, page: 1, done: [number] };
  if (cursor.done.length < GITHUB_LIMITS.doneMax) return { since: cursor.since, page: cursor.page, done: [...cursor.done, number] };
  return skipSecond(cursor, page);
}

export function createGithubAdapter(deps: BrainGithubAdapterDeps): BrainSourceAdapter<BrainGithubSourceConfig> {
  let rows: ReturnType<typeof githubConditionalRows> | null = null;
  const pending: { key: string; validators: BrainGithubValidators }[] = [];
  /** A failure that ended a non-empty page, held for the call continuing from that page's cursor. */
  let held: { readonly failure: GithubFailure; readonly cursor: string } | null = null;
  const client = deps.createClient({
    lookup: (key) => rows === null ? Promise.resolve(null) : rows.lookup(key),
    remember: (key, validators) => {
      if (pending.length < GITHUB_LIMITS.conditionalRowsPerSource) pending.push({ key, validators });
    },
  });

  async function readItem(
    context: BrainSourceReadContext<BrainGithubSourceConfig>, doc: GithubDocumentContext, issue: GithubIssue,
  ): Promise<{ ok: true; documents: GithubItemDocuments | null } | GithubFailure> {
    const isPull = issue.pull_request !== undefined;
    const include = context.config.include;
    if (isPull ? !include.pullRequests : !include.issues) return { ok: true, documents: null };
    if (!isPull) {
      const built = issueDocument(doc, issue);
      const notices: BrainSourceNotice[] = built.truncated ? ["body_truncated"] : [];
      return { ok: true, documents: { upserts: [built.upsert], deletions: [], notices, skipped: 0 } };
    }
    const result = await readPullRequest({ kysely: deps.kysely, client, doc, context, issue });
    // A pull request that vanished between the listing and its reads is passed over, not retried forever.
    if (!result.ok && result.code === "remote_not_found") return { ok: true, documents: null };
    return result;
  }

  return {
    kind: "github",
    async readPage(context) {
      const deferred = held;
      held = null;
      if (deferred !== null && deferred.cursor === context.cursor) {
        return fail(deferred.failure.code, deferred.failure.retryAfterSeconds);
      }
      if (githubExternalRef(context.config.repo) !== context.externalRef) return fail("config_invalid");
      const doc: GithubDocumentContext = { externalRef: context.externalRef, repo: context.config.repo };
      const stored = context.cursor === null ? null : decodeGithubCursor(context.cursor);
      if (context.cursor !== null && stored === null) return fail("cursor_invalid");
      let cursor: BrainGithubCursor = stored ?? { since: initialSince(context.config, context.now()), page: 1, done: [] };
      const startedAt = context.now().getTime();
      const conditional = githubConditionalRows(deps.kysely, context.scope, context.sourceId);
      rows = conditional;
      pending.length = 0;
      if (context.cursor !== null && client.mode === "token") await conditional.confirm(hashCursor(context.cursor));
      const request = { since: cursor.since, page: cursor.page };
      const listing = await client.read({ kind: "issues", ...request, perPage: GITHUB_LIMITS.listPerPage }, context.signal);
      if (!listing.ok) return fail(listing.code, listing.retryAfterSeconds);
      const page = new PageCollector(context.limits);
      if ("notModified" in listing) {
        page.notice("not_modified");
        const nextCursor = context.cursor ?? encodeGithubCursor(cursor);
        return { ok: true, page: { upserts: [], deletions: [], nextCursor, caughtUp: true, skipped: 0, notices: page.notices } };
      }
      const parsed = GithubIssueListSchema.safeParse(listing.data);
      if (!parsed.success) return fail("provider_output_invalid");
      const full = listing.hasMore || parsed.data.length >= GITHUB_LIMITS.listPerPage;
      const callsLimit = GITHUB_LIMITS.callsPerPage[client.mode];
      let calls = 1;
      let items = 0;
      let stopped = false;
      let progressed = false;
      let failure: GithubFailure | null = null;
      for (const issue of parsed.data) {
        const updatedAt = toGithubTime(Date.parse(issue.updated_at));
        if (updatedAt < cursor.since || (updatedAt === cursor.since && cursor.done.includes(issue.number))) continue;
        // Children already written on earlier pages, while the pull request has not changed since.
        const skip = cursor.open?.number === issue.number && cursor.open.updatedAt === updatedAt ? cursor.open.written : 0;
        const cost = issue.pull_request !== undefined && context.config.include.pullRequests ? pullRequestCalls(context.config) : 0;
        const overBudget = items >= GITHUB_LIMITS.itemsPerPage || calls + cost > callsLimit
          || context.now().getTime() - startedAt > GITHUB_LIMITS.pageSoftBudgetMs;
        if (context.signal.aborted || (items > 0 && overBudget)) {
          stopped = true;
          break;
        }
        const item = await readItem(context, doc, issue);
        if (!item.ok) {
          if (page.empty) return fail(item.code, item.retryAfterSeconds);
          failure = item;
          stopped = true;
          break;
        }
        calls += cost;
        items += 1;
        if (item.documents === null) page.skipped += 1;
        const added = item.documents === null ? DONE : page.add(item.documents, skip);
        if (added !== null && !added.done) {
          // Too big for one page: the watermark stays before it and the cursor keeps it open.
          const open = { number: issue.number, updatedAt, written: added.written };
          cursor = { since: cursor.since, page: cursor.page, done: cursor.done, open };
        }
        if (added === null || !added.done) {
          stopped = true;
          break;
        }
        cursor = advance(cursor, updatedAt, issue.number, page);
        progressed = true;
      }
      if (!stopped && full && !progressed) {
        // Every item on this page is tied at the watermark and already applied: look at the next page of ties.
        cursor = cursor.page < GITHUB_LIMITS.tiePagesMax
          ? { since: cursor.since, page: cursor.page + 1, done: cursor.done } : skipSecond(cursor, page);
      }
      const caughtUp = !stopped && !full;
      const nextCursor = encodeGithubCursor(cursor);
      if (failure !== null) held = { failure, cursor: nextCursor };
      if (caughtUp && pending.length > 0 && cursor.since === request.since && cursor.page === request.page) {
        await conditional.persist(pending, hashCursor(nextCursor), nextCursor === context.cursor, context.now());
      }
      return {
        ok: true,
        page: { upserts: page.upserts, deletions: page.deletions, nextCursor, caughtUp, skipped: page.skipped, notices: page.notices },
      };
    },
  };
}
