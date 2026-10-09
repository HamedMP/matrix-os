/**
 * The brief feature: the owner-scoped service (brief, conflicts, stale), the scheduled runner and the scope_erased
 * listener. Briefs are deterministic; a summary needs the flag and a model (summary_not_configured otherwise).
 */
import { z } from "zod/v4";
import { BRAIN_PROJECT_SCOPE_PREFIX, BrainApiError } from "../api/types.js";
import { brainCallCap, withBrainRead } from "../bounded.js";
import {
  BRAIN_BRIEF_SCHEDULE, BRAIN_CONFLICTS_DEFAULT_LIMIT, BRAIN_CONFLICTS_MAX_LIMIT, BRAIN_CONFLICT_RULES,
  BRAIN_FEATURE_CURSOR_MAX_CHARS, BRAIN_QUERY_LIST_MAX_ITEMS, BRAIN_SCHEDULED_SCOPES_MAX, BRAIN_STALE_KINDS,
  BrainFeatureError, type BrainBriefFeature, type BrainBriefRunner, type BrainBriefServiceDeps,
  type BrainBriefSummaryModel, type BrainBriefView, type BrainBriefWindow, type BrainChangeListener,
} from "../contracts.js";
import type { BrainScopeKey } from "../types.js";
import { computeConflicts } from "./conflicts.js";
import {
  citesDeleted, deleteStoredBriefs, purgeDeletedBriefs, readStoredBrief, unfinishedDays, writeStoredBrief,
  type BrainStoredBrief,
} from "./database.js";
import { pageOf, queryFingerprint } from "./paging.js";
import { buildSections } from "./sections.js";
import { computeStale, staleView } from "./stale.js";
import { summarizeBrief } from "./summary.js";
import { DAY_MS, briefWindow, iso, utcDate } from "./time.js";
import { BRIEF_FINISH_DAYS, BRIEF_REBUILD_AFTER_MS } from "./types.js";

const listOf = <T extends string>(values: readonly [T, ...T[]]) =>
  z.array(z.enum(values)).min(1).max(BRAIN_QUERY_LIST_MAX_ITEMS).optional();
const page = {
  limit: z.number().int().min(1).max(BRAIN_CONFLICTS_MAX_LIMIT).default(BRAIN_CONFLICTS_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(BRAIN_FEATURE_CURSOR_MAX_CHARS).optional(),
};
const ConflictsQuerySchema = z.object({ rules: listOf(BRAIN_CONFLICT_RULES), ...page }).strict();
const StaleQuerySchema = z.object({ kinds: listOf(BRAIN_STALE_KINDS), ...page }).strict();
const BriefQuerySchema = z.object({
  date: z.string().max(10).optional(), window: z.enum(["day", "week"]).default("day"),
  summary: z.boolean().default(false),
}).strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BrainApiError("invalid_request", { cause: parsed.error });
  return parsed.data;
}

/** Built before its window ended, and the window has ended or the copy is an hour old. */
export function needsRebuild(brief: BrainStoredBrief, now: Date): boolean {
  const generated = Date.parse(brief.generatedAt);
  const end = Date.parse(brief.to);
  return generated < end && (now.getTime() >= end || now.getTime() - generated >= BRIEF_REBUILD_AFTER_MS);
}

export function createBrainBrief(deps: BrainBriefServiceDeps): BrainBriefFeature {
  const db = deps.repository.kysely;
  const clock = deps.now ?? (() => new Date());
  const scopeOf = async (ownerId: string, projectRef: string): Promise<BrainScopeKey> =>
    (await deps.resolver.resolve(ownerId, projectRef)).scope;
  const capped = brainCallCap("brief build");

  /** A project scope whose project no longer resolves (deleted); a lookup outage throws. */
  async function projectGone(ownerId: string, scope: BrainScopeKey): Promise<boolean> {
    if (!scope.scopeId.startsWith(BRAIN_PROJECT_SCOPE_PREFIX)) return false;
    try {
      await deps.resolver.resolve(ownerId, scope.scopeId.slice(BRAIN_PROJECT_SCOPE_PREFIX.length));
      return false;
    } catch (error: unknown) {
      if (error instanceof BrainApiError && error.code === "project_not_found") return true;
      throw error;
    }
  }

  async function build(
    scope: BrainScopeKey, date: string, window: BrainBriefWindow, now: Date, model: BrainBriefSummaryModel | null,
  ): Promise<BrainBriefView> {
    const range = briefWindow(date, window, now);
    const earlier = (await readStoredBrief(db, scope, range.date, window))?.sections ?? null;
    const { sections, truncated } = await withBrainRead(db, (trx) => buildSections(trx, scope, range, now, earlier));
    const brief: BrainStoredBrief = {
      date: range.date, window, from: iso(range.from), to: iso(range.to), generatedAt: iso(now), sections,
      summary: null, truncated,
    };
    const full = model === null ? brief : { ...brief, summary: await summarizeBrief(model, brief, clock) };
    return { ...full, stored: await writeStoredBrief(db, scope, full) };
  }

  const service: BrainBriefFeature["service"] = {
    async getBrief(ownerId, projectRef, query) {
      const input = parse(BriefQuerySchema, query);
      const scope = await scopeOf(ownerId, projectRef);
      const now = clock();
      const range = briefWindow(input.date, input.window, now);
      const stored = await readStoredBrief(db, scope, range.date, input.window);
      // A tombstone removes content: a copy citing a document deleted since is dropped (unless replaced) and rebuilt.
      if (stored !== null && await citesDeleted(db, scope, stored)) await deleteStoredBriefs(db, scope, stored);
      else if (stored !== null && !needsRebuild(stored, now)) return { ...stored, stored: true };
      return capped(() => build(scope, range.date, input.window, now, null));
    },
    async generateBrief(ownerId, projectRef, body) {
      const input = parse(BriefQuerySchema, body);
      const scope = await scopeOf(ownerId, projectRef);
      const now = clock();
      const range = briefWindow(input.date, input.window, now);
      const model = input.summary && deps.summaries !== undefined ? await deps.summaries() : null;
      if (input.summary && model === null) throw new BrainFeatureError("summary_not_configured");
      return capped(() => build(scope, range.date, input.window, now, model));
    },
    async conflicts(ownerId, projectRef, query) {
      const input = parse(ConflictsQuerySchema, query);
      const scope = await scopeOf(ownerId, projectRef);
      const rules = BRAIN_CONFLICT_RULES.filter((rule) => input.rules?.includes(rule) ?? true);
      const items = await withBrainRead(db, (trx) => computeConflicts(trx, scope, rules));
      return pageOf(items, input.limit, input.cursor, queryFingerprint(["conflicts", rules]));
    },
    async stale(ownerId, projectRef, query) {
      const input = parse(StaleQuerySchema, query);
      const scope = await scopeOf(ownerId, projectRef);
      const kinds = BRAIN_STALE_KINDS.filter((kind) => input.kinds?.includes(kind) ?? true);
      const now = clock();
      const stale = { kinds, now, overdueBefore: utcDate(now), before: null };
      const items = await withBrainRead(db, (trx) => computeStale(trx, scope, stale));
      const page = pageOf(items, input.limit, input.cursor, queryFingerprint(["stale", kinds]));
      return { items: page.items.map(staleView), nextCursor: page.nextCursor };
    },
  };

  let tries = 0;
  /** When this runner last tried each scope of the last pass's list (so at most BRAIN_SCHEDULED_SCOPES_MAX). */
  let tried = new Map<string, number>();
  /**
   * Per scope: drops stored briefs citing deleted documents, skips a project scope whose project is gone, then builds
   * today's day brief (skipped when fresh) and a final rebuild of each stored day copy of the last BRIEF_FINISH_DAYS
   * built before its day ended, so a failed one is retried. Scopes tried least lately go first (ties: the lister's
   * order, stalest brief first), so one that fails or runs long every pass never holds the others back.
   */
  const runner: BrainBriefRunner = async ({ ownerId, now, scopes, signal }) => {
    const deadline = performance.now() + BRAIN_BRIEF_SCHEDULE.passBudgetMs;
    const stopped = () => signal.aborted || performance.now() > deadline;
    const max = BRAIN_SCHEDULED_SCOPES_MAX;
    const last = (scope: BrainScopeKey) => tried.get(scope.scopeId) ?? 0;
    const list = (await scopes.listActiveScopes(ownerId, max)).slice(0, max).sort((x, y) => last(x) - last(y));
    tried = new Map(list.map((scope) => [scope.scopeId, last(scope)]));
    const today = utcDate(now);
    const since = utcDate(new Date(now.getTime() - BRIEF_FINISH_DAYS * DAY_MS));
    let built = 0;
    let failed = 0;
    let skipped = 0;
    for (const scope of list) {
      if (stopped()) {
        skipped += 1;
        continue;
      }
      tried.set(scope.scopeId, ++tries);
      try {
        await purgeDeletedBriefs(db, scope);
        if (await projectGone(ownerId, scope)) {
          skipped += 1;
          continue;
        }
        const current = await readStoredBrief(db, scope, today, "day");
        const todo = [
          ...(current === null || needsRebuild(current, now) ? [today] : []),
          ...await unfinishedDays(db, scope, since, today),
        ];
        let done = 0;
        // The same cap as requests (never a third build while two run); a stop or the deadline ends it before a build.
        for (const date of todo) {
          if (stopped()) break;
          await capped(() => build(scope, date, "day", now, null));
          done += 1;
        }
        if (done > 0) built += 1;
        else skipped += 1;
      } catch (error: unknown) {
        failed += 1;
        console.error("[brain-brief] Scheduled brief failed:", error instanceof Error ? error.name : "UnknownError");
      }
    }
    return { scopes: list.length, built, failed, skipped };
  };

  const listener: BrainChangeListener = {
    name: "brief",
    async handle(event) {
      if (event.type === "scope_erased") await deleteStoredBriefs(db, event.scope);
      else if (event.type === "documents_changed") await purgeDeletedBriefs(db, event.scope);
    },
  };

  return { service, runner, listener };
}
