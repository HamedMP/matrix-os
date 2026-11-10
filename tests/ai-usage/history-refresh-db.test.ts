import { afterAll, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
const exec = promisify(execFile),
  url = process.env.MATRIX_TEST_POSTGRES_URL;
const db = url
  ? new Kysely<any>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString: url,
          max: 2,
          connectionTimeoutMillis: 5000,
        }),
      }),
    })
  : null;
afterAll(() => db?.destroy());
it.runIf(Boolean(url))(
  "refresh indexes preserved originals when a configured machine has a custom name",
  async () => {
    if (!db || !url || !new URL(url).pathname.includes("test"))
      throw new Error("Disposable PostgreSQL required");
    const schema = "usage_refresh_" + Date.now(),
      root = await mkdtemp(join(tmpdir(), "usage-refresh-"));
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(db);
    try {
      const source = join(root, "mac/.claude/projects"),
        archived = join(root, "recovered/mac/.claude/projects");
      await mkdir(source, { recursive: true });
      await mkdir(archived, { recursive: true });
      const record = (id: string, timestamp: string) =>
        JSON.stringify({
          type: "assistant",
          sessionId: "session",
          requestId: id,
          timestamp,
          message: {
            id,
            model: "unknown",
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        }) + "\n";
      await writeFile(
        join(source, "current.jsonl"),
        record("current", "2026-01-01T12:00:00Z"),
      );
      await writeFile(
        join(archived, "older.jsonl"),
        record("older", "2024-01-01T12:00:00Z"),
      );
      const config = join(root, "collector.json");
      await writeFile(
        config,
        JSON.stringify({
          owner: "owner",
          machines: [
            { id: "laptop", roots: [{ path: source, agent: "claude" }] },
          ],
          backupManifest: join(root, "manifest.json"),
        }),
      );
      const connection = new URL(url);
      connection.searchParams.set(
        "options",
        `${connection.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim(),
      );
      await exec(
        process.execPath,
        ["--import", "tsx", "scripts/ai-usage/refresh.ts", config],
        {
          env: { ...process.env, AI_USAGE_DATABASE_URL: connection.href },
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
      );
      const report = JSON.parse(
        await readFile(join(root, "usage-report.json"), "utf8"),
      );
      expect(
        report.history.reports.find(
          (r: any) => r.id === "all" && r.agent === "",
        ).summary.tokens,
      ).toBe(24);
      expect(report.history.coverage.files).toBe(2);
      expect(report.history.coverage.oldest).toBe("2024-01-01T12:00:00Z");
    } finally {
      await rm(root, { recursive: true });
      await sql.raw(`DROP SCHEMA ${schema} CASCADE`).execute(db);
    }
  },
  30_000,
);
