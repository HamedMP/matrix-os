/** Owner-controlled full-history CLI. Run on the Matrix computer with its private database URL. */
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { readClaudeAccountHistory } from "./account-history";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UsageHistoryRepository } from "../../packages/gateway/src/ai-usage/history-repository";
import { indexUsageRoots } from "../../packages/gateway/src/ai-usage/history-collector";
import { readUsageHistory } from "../../packages/gateway/src/ai-usage/history-service";
const [configFile, output] = process.argv.slice(2);
if (!configFile || !output || !process.env.AI_USAGE_DATABASE_URL)
  throw new Error("Private config, output and AI_USAGE_DATABASE_URL required");
const config = JSON.parse(await readFile(configFile, "utf8")) as {
  owner: string;
  machines: Array<{
    id: string;
    label?: string;
    roots: Array<{ path: string; agent: "claude" | "codex" }>;
  }>;
  backupManifest?: string;
  legacyCache?: string;
  accountExport?: string;
  preservedAgents?: string[];
  desktopExport?: { home: string; ownerId: string };
};
const db = new Kysely<any>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({
      connectionString: process.env.AI_USAGE_DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 10000,
      statement_timeout: 120000,
    }),
  }),
});
try {
  const repo = new UsageHistoryRepository(db);
  await repo.bootstrap();
  let failedRoots = 0;
  for (const machine of config.machines) {
    const result = await indexUsageRoots(
      repo,
      config.owner,
      machine.id,
      machine.roots,
    );
    failedRoots += result.failed;
    console.error(
      `Indexed ${machine.id}: ${result.indexed} files; ${result.failed} incomplete roots`,
    );
  }
  const snapshot = await readUsageHistory(repo, config.owner, {
    timeZone: process.env.AI_USAGE_TIMEZONE ?? "Europe/Stockholm", failedRoots,
  });
  const coverage = snapshot.history.coverage;
  coverage.machines = [...new Set(config.machines.map(m => m.label ?? m.id))];
  if (config.backupManifest) {
    const manifest = JSON.parse(await readFile(config.backupManifest, "utf8"));
    if (manifest.verified === true)
      coverage.backup = {
        verifiedFiles: manifest.files,
        verifiedBytes: manifest.bytes,
        verifiedAt: manifest.verifiedAt,
      };
  }
  if (config.legacyCache) {
    const cache = JSON.parse(await readFile(config.legacyCache, "utf8"));
    const days = (cache.dailyActivity ?? [])
      .map((d: { date: string }) => d.date)
      .sort();
    if (days.length)
      coverage.legacyActivity = {
        firstDay: days[0],
        lastDay: days.at(-1),
        days: days.length,
        sessions: cache.totalSessions ?? 0,
        label:
          "Historical Claude activity cache; overlaps transcripts and is excluded from token totals",
      };
  }
  if (config.accountExport)
    coverage.webHistory = await readClaudeAccountHistory(config.accountExport);
  coverage.preservedAgents = config.preservedAgents;
  // Exports are files; authoritative app data/checkpoints stay in owner Postgres.
  await writeFile(output + ".pending", JSON.stringify(snapshot), {
    mode: 0o600,
  });
  await rename(output + ".pending", output);
  if (config.desktopExport) {
    const directory = join(config.desktopExport.home, "exports", "ai-usage");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "latest.json");
    await writeFile(
      path + ".pending",
      JSON.stringify({
        version: 1,
        ownerId: config.desktopExport.ownerId,
        report: snapshot,
      }),
      { mode: 0o600 },
    );
    await rename(path + ".pending", path);
  }
  console.error(
    `Full-history report ready: ${coverage.files} files, ${coverage.indexedBytes} indexed bytes; ${failedRoots} failed roots`,
  );
  if (failedRoots) process.exitCode = 1;
} finally {
  await db.destroy();
}
