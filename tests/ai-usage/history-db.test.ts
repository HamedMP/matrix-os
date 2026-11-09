import { afterAll, expect, it, vi } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { zstdCompressSync } from "node:zlib";
import { mkdtemp, writeFile, appendFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageHistoryRepository } from "../../packages/gateway/src/ai-usage/history-repository";
import { createAiUsageRoutes } from "../../packages/gateway/src/ai-usage/routes";
import { readUsageHistory } from "../../packages/gateway/src/ai-usage/history-service";
import { indexUsageRoots } from "../../packages/gateway/src/ai-usage/history-collector";
// The required hosted PostgreSQL lane supplies this URL and rejects skipped/empty suites.
// Ordinary unit runs do not need a database server.
const url = process.env.MATRIX_TEST_POSTGRES_URL;
const db = url
  ? new Kysely<any>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString: url,
          max: 2,
          connectionTimeoutMillis: 5000,
          statement_timeout: 10000,
        }),
      }),
    })
  : null;
afterAll(() => db?.destroy());
it.runIf(Boolean(url))(
  "checkpoints real files transactionally, resumes tails, deduplicates machine mirrors and isolates owners",
  async () => {
    if (!db || !url || !new URL(url).pathname.includes("test"))
      throw new Error("Disposable PostgreSQL test database required");
    const schema = "usage_test_" + Date.now();
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(db);
    const repo = new UsageHistoryRepository(db.withSchema(schema));
    const root = await mkdtemp(join(tmpdir(), "usage-history-"));
    try {
      await repo.bootstrap();
      const record = (output: number) =>
        JSON.stringify({
          type: "assistant",
          timestamp: "2025-01-01T00:00:00Z",
          sessionId: "s",
          requestId: "r",
          message: {
            id: "m",
            model: "unknown",
            usage: { input_tokens: 2, output_tokens: output },
          },
        });
      const file = join(root, "one.jsonl");
      await writeFile(file, record(3) + "\n");
      expect(
        await indexUsageRoots(repo, "owner-a", "mac", [
          { path: root, agent: "claude" },
        ]),
      ).toEqual({ indexed: 1, failed: 0 });
      const before = await repo.getSource("owner-a", "mac", file);
      await appendFile(file, record(5));
      expect(
        await indexUsageRoots(repo, "owner-a", "mac", [
          { path: root, agent: "claude" },
        ]),
      ).toEqual({ indexed: 1, failed: 0 });
      expect((await repo.getSource("owner-a", "mac", file))?.offset).toBe(
        before?.offset,
      );
      const tailIssues = (await repo.getSource("owner-a", "mac", file))!.issues;
      expect(
        await indexUsageRoots(repo, "owner-a", "mac", [
          { path: root, agent: "claude" },
        ]),
      ).toEqual({ indexed: 1, failed: 0 });
      expect((await repo.getSource("owner-a", "mac", file))!.issues).toBe(
        tailIssues,
      );
      await appendFile(file, "\n");
      expect(
        await indexUsageRoots(repo, "owner-a", "mac", [
          { path: root, agent: "claude" },
        ]),
      ).toEqual({ indexed: 1, failed: 0 });
      await indexUsageRoots(repo, "owner-a", "matrix", [
        { path: root, agent: "claude" },
      ]);
      const events = [];
      for await (const e of repo.events("owner-a")) events.push(e);
      expect(events).toHaveLength(1);
      expect(events[0].output).toBe(5);
      const other = [];
      for await (const e of repo.events("owner-b")) other.push(e);
      expect(other).toHaveLength(0);
      expect((await repo.coverage("owner-a")).sources).toHaveLength(2);
      await writeFile(
        join(root, "archive.jsonl.zst"),
        zstdCompressSync(Buffer.from(record(5) + "\n")),
      );
      await writeFile(
        join(root, "rollout-old.json"),
        JSON.stringify({
          session: { id: "old", timestamp: "2023-01-01T00:00:00Z" },
          items: [{ type: "message", role: "user", content: [] }],
        }),
      );
      expect(
        await indexUsageRoots(repo, "owner-a", "archives", [
          { path: root, agent: "claude" },
        ]),
      ).toEqual({ indexed: 3, failed: 0 });
      // Same-size overwrite must invalidate the old checkpoint and stale observations.
      await writeFile(file, record(9) + "\n");
      expect(
        await indexUsageRoots(repo, "owner-a", "mac", [
          { path: root, agent: "claude" },
        ]),
      ).toEqual({ indexed: 3, failed: 0 });
      const replaced = [];
      for await (const e of repo.events("owner-a")) replaced.push(e);
      expect(replaced[0].output).toBe(9);
      const app = createAiUsageRoutes({
        homePath: root,
        runtimeOwnerId: "owner-a",
        getOwnerId: () => "owner-a",
        history: { read: () => readUsageHistory(repo, "owner-a") },
      });
      const response = await app.request("/api/ai-usage");
      expect(response.status).toBe(200);
      const report = await response.json();
      expect(
        report.history.reports.find(
          (r: any) => r.id === "all" && r.agent === "",
        ).summary.tokens,
      ).toBe(11);
      expect(report.history.coverage.files).toBe(7);
      expect(report.history.coverage.oldestActivity).toBe(
        "2023-01-01T00:00:00Z",
      );
      expect(report.history.coverage.activityOnlySessions).toBe(1);
      expect(JSON.stringify(report)).not.toContain(root);
      const codexRoot = join(root, "codex");
      await mkdir(codexRoot);
      const total = (input: number, output: number) => ({
        type: "event_msg",
        timestamp: "2026-10-01T12:00:00Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: 0,
              output_tokens: output,
            },
          },
        },
      });
      const native = (id: string, input: number, output: number) => ({
        type: "token_usage_record",
        timestamp: "2026-10-01T12:00:00Z",
        payload: {
          thread_id: "native",
          response_id: id,
          usage: {
            input_tokens: input,
            cached_input_tokens: 0,
            output_tokens: output,
          },
          thread_token_usage: {
            input_tokens: input,
            cached_input_tokens: 0,
            output_tokens: output,
          },
        },
      });
      const meta = { type: "session_meta", payload: { id: "native" } };
      await writeFile(
        join(codexRoot, "legacy.jsonl"),
        [meta, total(100, 10)].map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
      await writeFile(
        join(codexRoot, "native.jsonl"),
        [
          meta,
          native("first", 100, 10),
          total(100, 10),
          native("second", 50, 5),
          total(50, 5),
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      );
      expect(
        await indexUsageRoots(repo, "owner-c", "mac", [
          { path: codexRoot, agent: "codex" },
        ]),
      ).toEqual({ indexed: 2, failed: 0 });
      const exact = await readUsageHistory(repo, "owner-c");
      expect(
        exact.history.reports.find((r) => r.id === "all" && r.agent === "")!
          .summary.tokens,
      ).toBe(165);
      // A recent native request is only the tail of the recovered cumulative interval.
      const partialRoot = join(root, "partial");
      await mkdir(partialRoot);
      const tail = native("tail", 100, 10);
      tail.payload.thread_token_usage = {
        input_tokens: 200,
        cached_input_tokens: 0,
        output_tokens: 20,
      };
      await writeFile(
        join(partialRoot, "legacy.jsonl"),
        [meta, total(100, 10), total(150, 15), total(200, 20)]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      );
      await writeFile(
        join(partialRoot, "native.jsonl"),
        [meta, tail].map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
      await indexUsageRoots(repo, "partial-owner", "mac", [
        { path: partialRoot, agent: "codex" },
      ]);
      const partial = await readUsageHistory(repo, "partial-owner");
      expect(
        partial.history.reports.find((r) => r.id === "all" && r.agent === "")!
          .summary.tokens,
      ).toBe(220);
    } finally {
      await rm(root, { recursive: true });
      await sql.raw(`DROP SCHEMA ${schema} CASCADE`).execute(db);
    }
  },
);

it.runIf(Boolean(url))(
  "does not sum ambiguous Codex mirrors, replaces growing rewrites, and reads one database snapshot",
  async () => {
    if (!db || !url || !new URL(url).pathname.includes("test"))
      throw new Error("Disposable PostgreSQL required");
    const schema = "usage_regression_" + Date.now();
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(db);
    const repo = new UsageHistoryRepository(db.withSchema(schema));
    const root = await mkdtemp(join(tmpdir(), "usage-regression-"));
    const write = (name: string, rows: unknown[]) =>
      writeFile(
        join(root, name),
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
    const record = (id: string, date = "2026-10-01T00:00:00Z") => ({
      type: "assistant",
      sessionId: "rewrite",
      requestId: id,
      timestamp: date,
      message: {
        id,
        model: "unknown",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    });
    try {
      await repo.bootstrap();
      const meta = { type: "session_meta", payload: { id: "mirror" } };
      await write("native.jsonl", [
        meta,
        {
          type: "token_usage_record",
          timestamp: "2026-10-01T00:00:00Z",
          payload: {
            thread_id: "mirror",
            response_id: "response",
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              cached_input_tokens: 0,
            },
          },
        },
      ]);
      await write("legacy.jsonl", [
        meta,
        {
          type: "event_msg",
          timestamp: "2026-10-01T00:00:00Z",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                output_tokens: 10,
                cached_input_tokens: 0,
              },
            },
          },
        },
      ]);
      await indexUsageRoots(repo, "mirror-owner", "mac", [
        { path: root, agent: "codex" },
      ]);
      const report = await readUsageHistory(repo, "mirror-owner");
      expect(
        report.history.reports.find((r) => r.id === "all" && r.agent === "")!
          .summary.tokens,
      ).toBe(110);
      expect(report.issues).toBeGreaterThan(0);

      const file = join(root, "rewrite.jsonl");
      const prefix = {
        type: "user",
        sessionId: "rewrite",
        message: { content: "x".repeat(6000) },
      };
      await write("rewrite.jsonl", [prefix, record("old")]);
      await indexUsageRoots(repo, "rewrite-owner", "mac", [
        { path: file, agent: "claude" },
      ]);
      const oldEvents = [];
      for await (const e of repo.events("rewrite-owner")) oldEvents.push(e);
      await write("rewrite.jsonl", [
        prefix,
        record("replacement-with-a-longer-id"),
      ]);
      await indexUsageRoots(repo, "rewrite-owner", "mac", [
        { path: file, agent: "claude" },
      ]);
      const events = [];
      for await (const e of repo.events("rewrite-owner")) events.push(e);
      expect(events).toHaveLength(1);
      expect(events[0].id).not.toBe(oldEvents[0].id);
      const replacement = await readUsageHistory(repo, "rewrite-owner");
      expect(
        replacement.history.reports.find(
          (r) => r.id === "all" && r.agent === "",
        )!.summary.tokens,
      ).toBe(110);

      await write("initial.jsonl", [record("initial")]);
      await indexUsageRoots(repo, "snapshot-owner", "mac", [
        { path: join(root, "initial.jsonl"), agent: "claude" },
      ]);
      await write("older.jsonl", [record("older", "2024-01-01T00:00:00Z")]);
      const originalBounds = UsageHistoryRepository.prototype.bounds;
      let inserted = false,
        visited = 0;
      vi.spyOn(UsageHistoryRepository.prototype, "bounds").mockImplementation(
        async function (owner) {
          const result = await originalBounds.call(this, owner);
          if (owner === "snapshot-owner" && !inserted) {
            inserted = true;
            await indexUsageRoots(repo, owner, "mac", [
              { path: join(root, "older.jsonl"), agent: "claude" },
            ]);
          }
          return result;
        },
      );
      const originalVisit = UsageHistoryRepository.prototype.visitEvents;
      vi.spyOn(
        UsageHistoryRepository.prototype,
        "visitEvents",
      ).mockImplementation(function (owner, visit) {
        return originalVisit.call(this, owner, (e) => {
          if (this.db.isTransaction) visited++;
          visit(e);
        });
      });
      const snapshot = await readUsageHistory(repo, "snapshot-owner");
      expect(visited).toBe(1);
      expect(
        snapshot.history.reports.find((r) => r.id === "all" && r.agent === "")!
          .summary.tokens,
      ).toBe(110);
      vi.restoreAllMocks();
      const next = await readUsageHistory(repo, "snapshot-owner");
      expect(
        next.history.reports.find((r) => r.id === "all" && r.agent === "")!
          .summary.tokens,
      ).toBe(220);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true });
      await sql.raw(`DROP SCHEMA ${schema} CASCADE`).execute(db);
    }
  },
);
