import type { Kysely } from "kysely";
import { usageRoots } from "@matrix-os/contracts/ai-usage/node";
import {
  createHistoryReports,
  type UsageHistoryCoverage,
} from "@matrix-os/contracts/ai-usage";
import { readUsageRootConfig } from "./history-config";
import { UsageHistoryRepository } from "./history-repository";
import { indexUsageRoots } from "./history-collector";
export async function readUsageHistory(
  repo: UsageHistoryRepository,
  owner: string,
  options: { timeZone?: string; failedRoots?: number; indexing?: boolean } = {},
) {
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
    issues: progress.sources.reduce((n, s) => n + s.issues, normalized.issues),
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
            { path: claude, agent: "claude" },
            { path: codex, agent: "codex" },
            { path: archives, agent: "codex" },
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
        if (!controller.signal.aborted) {
          timer = setTimeout(run, options.intervalMs ?? 15 * 60 * 1000);
          timer.unref?.();
        }
      });
  };
  run();
  return {
    async read() {
      await ready;
      return readUsageHistory(repo, options.owner, {
        indexing: Boolean(pending),
        failedRoots,
      });
    },
    async dispose() {
      controller.abort();
      if (timer) clearTimeout(timer);
      await pending;
    },
  };
}
