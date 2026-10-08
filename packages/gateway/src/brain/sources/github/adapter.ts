/**
 * GitHub source adapter: one readPage call reads the repository's issue listing (issues and pull requests, oldest
 * update first, from the cursor's watermark) and maps up to a bounded number of items to documents. A page stops
 * early at its item, provider call, document, ref and time limits, or at the first provider failure (the items read
 * so far are still returned; the failure comes back on the next call). Each item moves the cursor only once its
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
