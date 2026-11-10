import type { Kysely } from "kysely";
import { usageRoots } from "@matrix-os/contracts/ai-usage/node";
import {
  createHistoryReports,
  type UsageHistoryCoverage,
} from "@matrix-os/contracts/ai-usage";
import { readUsageRootConfig } from "./history-config.js";
import { UsageHistoryRepository } from "./history-repository.js";
import { indexUsageRoots } from "./history-collector.js";
export async function readUsageHistory(
  repo: UsageHistoryRepository,
  owner: string,
  options: { timeZone?: string; failedRoots?: number; indexing?: boolean } = {},
) {
  return repo.withSnapshot(async repo => {
  const [bounds, progress, activity] = await Promise.all([
    repo.bounds(owner),
    repo.coverage(owner),
    repo.activity(owner),
  ]);
  const builder = createHistoryReports(
    activity.oldestActivity ?? bounds.oldest,
    options.timeZone ?? "UTC",
  );
  const normalized = await repo.visitEvents(owner, (e) => builder.push(e));
  const coverage: UsageHistoryCoverage = {
    machines: [...new Set(progress.sources.map((s) => s.machine))],
    files: progress.sources.reduce((n, s) => n + s.files, 0),
    bytes: progress.sources.reduce((n, s) => n + s.bytes, 0),
    indexedBytes: progress.sources.reduce((n, s) => n + s.indexedBytes, 0),
    oldest: bounds.oldest,
    newest: bounds.newest,
    oldestActivity: activity.oldestActivity,
    activityOnlySessions: Number(activity.activityOnlySessions),
    issues: progress.sources.reduce(
      (n, s) => n + s.issues,
      normalized.issues + builder.outsideRange(),
    ),
    failedRoots: options.failedRoots ?? 0,
    indexedAt: new Date().toISOString(),
    indexing: options.indexing ?? false,
  };
  return {
    version: 1 as const,
    events: [],
    issues: coverage.issues,
    history: {
      timeZone: options.timeZone ?? "UTC",
      reports: builder.finish(),
      coverage,
    },
  };
  });
}
/** Each build scans the whole index, so only one runs at a time, whichever timezone asked.
 * Readers of the same timezone share an unfinished build; a finished one is reused briefly.
 * Waiting builds are capped: a caller beyond the cap is refused rather than queued without limit. */
export function createReportCache<T>(
  build: (timeZone: string) => Promise<T>,
  options: { ttlMs: number; max?: number; maxWaiting?: number; now?: () => number },
) {
  const now = options.now ?? Date.now,
    max = options.max ?? 4,
    maxWaiting = options.maxWaiting ?? 8;
  // Finished reports: at most `max` timezones, oldest evicted first, cleared when indexing changes the data.
  const finished = new Map<string, { value: T; at: number }>();
  // Unfinished builds: entries leave when they settle; `waiting` caps how many may exist.
  const building = new Map<string, Promise<T>>();
  let waiting = 0,
    generation = 0,
    tail: Promise<unknown> = Promise.resolve();
  return {
    read(timeZone: string): Promise<T> {
      const cached = finished.get(timeZone);
      if (cached && now() - cached.at < options.ttlMs)
        return Promise.resolve(cached.value);
      const shared = building.get(timeZone);
      if (shared) return shared;
      if (waiting >= maxWaiting)
        return Promise.reject(new Error("Usage report queue is full"));
      waiting++;
      const started = generation;
      const run = tail.then(() => build(timeZone));
      tail = run.then(
        () => undefined,
        () => undefined, // The caller receives the failure; the queue only needs to move on.
      );
      const report = run
        .then((value) => {
          // A build that started before new indexing finished must not be kept as current.
          if (started === generation) {
            finished.delete(timeZone);
            while (finished.size >= max)
              finished.delete(finished.keys().next().value as string);
            finished.set(timeZone, { value, at: now() });
          }
          return value;
        })
        .finally(() => {
          waiting--;
          if (building.get(timeZone) === report) building.delete(timeZone);
        });
      building.set(timeZone, report);
      return report;
    },
    invalidate() {
      generation++;
      finished.clear();
      building.clear(); // Later readers start a fresh build, still behind the running one.
    },
    size: () => finished.size,
  };
}
/** Gateway lifecycle owns the timer/abort; injected owner pool remains open until its existing shutdown. */
export function startUsageHistory(options: {
  db: Kysely<any>;
  owner: string;
  home: string;
  intervalMs?: number;
}) {
  const repo = new UsageHistoryRepository(options.db),
    controller = new AbortController();
  const ready = repo.bootstrap();
  let timer: ReturnType<typeof setTimeout> | undefined,
    pending: Promise<void> | undefined,
    failedRoots = 0;
  const reports = createReportCache(
    (timeZone: string) =>
      readUsageHistory(repo, options.owner, {
        timeZone,
        indexing: Boolean(pending),
        failedRoots,
      }),
    { ttlMs: 60_000 },
  );
  const run = () => {
    pending = ready
      .then(async () => {
        const [claude, codex, archives] = usageRoots(options.home, {
          codexRoot: process.env.CODEX_HOME,
          claudeRoot: process.env.CLAUDE_CONFIG_DIR,
        });
        const result = await indexUsageRoots(
          repo,
          options.owner,
          "Matrix computer",
          [
            { path: claude, agent: "claude", optional: true },
            { path: codex, agent: "codex", optional: true },
            { path: archives, agent: "codex", optional: true },
          ],
          controller.signal,
        );
        failedRoots = result.failed;
        for (const source of await readUsageRootConfig(options.home)) {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- one decoder and bounded database writer run at a time across recovered machines
          const imported = await indexUsageRoots(
            repo,
            options.owner,
            source.machine,
            [{ path: source.path, agent: source.agent }],
            controller.signal,
          );
          failedRoots += imported.failed;
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          failedRoots++;
          console.warn(
            "[ai-usage] history worker unavailable",
            error instanceof Error ? error.name : "UnknownError",
          );
        }
      })
      .finally(() => {
        pending = undefined;
        reports.invalidate();
        if (!controller.signal.aborted) {
          timer = setTimeout(run, options.intervalMs ?? 15 * 60 * 1000);
          timer.unref?.();
        }
      });
  };
  run();
  return {
    async read(timeZone = "UTC") {
      await ready;
      return reports.read(timeZone);
    },
    async dispose() {
      controller.abort();
      if (timer) clearTimeout(timer);
      await pending;
    },
  };
}
