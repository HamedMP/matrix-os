import type { KyselyPlugin } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeConflicts } from "../../packages/gateway/src/brain/brief/conflicts.js";
import { buildSections } from "../../packages/gateway/src/brain/brief/sections.js";
import { briefWindow } from "../../packages/gateway/src/brain/brief/time.js";
import { computeStale, openCommitments } from "../../packages/gateway/src/brain/brief/stale.js";
import { BRIEF_SCANS } from "../../packages/gateway/src/brain/brief/types.js";
import {
  BRIEF_OWNER, BRIEF_SCOPE, createBriefFixture, prBody, type BriefFixture,
} from "./helpers/brain-brief-fixture.js";

let fx: BriefFixture;
beforeEach(async () => {
  fx = await createBriefFixture();
});
afterEach(async () => {
  await fx.destroy();
});

const conflicts = (query = {}) => fx.feature.service.conflicts(BRIEF_OWNER, "proj_a", query);
const stale = (query = {}) => fx.feature.service.stale(BRIEF_OWNER, "alpha", query);
const errorOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);
const day = (n: number) => `2026-09-${String(n).padStart(2, "0")}T08:00:00.000Z`;

describe("conflicts", () => {
  it("finds label disagreements by negation or by values, newest side first, cross-source first", async () => {
    const git = await fx.source();
    const linear = await fx.source("linear", "Linear");
    const said = (text: string) => `Storage: ${text}`;
    await fx.sync(git, [
      { seed: "a", body: said("tokens are stored in Postgres."), at: day(1) },
      { seed: "b", body: said("at most 8 runs per owner."), at: day(2) },
      { seed: "c", body: said("at most 16 runs per owner."), at: day(3) },
      { seed: "d", body: "Deferred scope: tokens are not stored in Postgres.", at: day(4) },
      { seed: "e", body: said("tokens are stored in Postgres. Also tokens are not stored in Postgres."), at: day(5) },
      { seed: "g", body: said("tokens are stored in Postgres."), at: day(7) },
      { seed: "h", body: said("tokens are stored in Postgres."), at: day(8) },
    ]);
    await fx.sync(linear, [{ seed: "f", body: said("tokens are never stored in Postgres."), at: day(6), refs: [{ kind: "handle", value: "ENG-7" }] }]);
    const invariant = (seed: string, label: string, statement: string) =>
      fx.extract(seed, [{ kind: "invariant", label, statement }]);
    await invariant("a", "Storage", "tokens are stored in Postgres.");
    await invariant("b", "Storage", "at most 8 runs per owner.");
    await invariant("c", "Storage", "at most 16 runs per owner.");
    await invariant("d", "Deferred scope", "tokens are not stored in Postgres.");
    await fx.extract("e", [
      { kind: "invariant", label: "Storage", statement: "tokens are stored in Postgres." },
      { kind: "invariant", label: "Storage", statement: "Also tokens are not stored in Postgres." },
    ]);
    await invariant("f", "Storage", "tokens are never stored in Postgres.");
    await invariant("g", "Storage", "tokens are stored in Postgres.");
    await invariant("h", "Storage", "tokens are stored in Postgres.");
    const view = await conflicts();
    const pairs = view.items.map((item) => `${item.sides[0].cite.label}>${item.sides[1].cite.label}`);
    expect(pairs.slice(0, 4).sort()).toEqual(["Title g>ENG-7", "Title g>Title e", "Title h>ENG-7", "Title h>Title e"]);
    expect(pairs.slice(4)).toEqual(["ENG-7>Title e", "Title e>Title a", "Title c>Title b"]);
    const first = view.items[4]!;
    expect(first.summary).toBe("ENG-7 and Title e disagree on \"Storage\"");
    expect(first.conflictId).toMatch(/^cfl_[a-f0-9]{32}$/);
    expect(first.detectedAt).toBe(day(6));
    const before = await computeConflicts(fx.harness.db, BRIEF_SCOPE, ["label_disagreement"], new Date(day(4)));
    expect(before.map((item) => item.detectedAt)).toEqual([day(3)]);
    expect(first.sides[0]).toMatchObject({ statement: "tokens are never stored in Postgres.", quote: "tokens are never stored in Postgres." });
    expect((await conflicts()).items.map((item) => item.conflictId)).toEqual(view.items.map((item) => item.conflictId));
  });

  it("finds Draft specs with later merged work outside specs/", async () => {
    const git = await fx.source();
    const github = await fx.source("github", "GitHub");
    const spec = (seed: string, title: string, body: string, at: string) => ({
      seed, title, body, at, provenance: "git_spec",
      refs: [{ kind: "spec", value: "specs/100-x" }, { kind: "path", value: "specs/100-x/spec.md" }],
    });
    await fx.sync(git, [
      spec("s1", "X", "# X\n\n**Status:** Draft (v2)\n", day(5)),
      spec("s2", "X (part 2 of 2)", "Status: Draft\n", day(5)),
      { seed: "early", provenance: "git_pr", body: prBody("Early.", 1), at: day(4),
        refs: [{ kind: "spec", value: "specs/100-x" }, { kind: "path", value: "src/a.ts" }] },
      { seed: "docs", provenance: "git_pr", body: prBody("Docs.", 2), at: day(6),
        refs: [{ kind: "spec", value: "specs/100-x" }, { kind: "path", value: "specs/100-x/plan.md" }] },
      { seed: "ship", title: "feat: ship X", provenance: "git_pr", body: prBody("Ship.", 3), at: day(7),
        refs: [{ kind: "spec", value: "specs/100-x" }, { kind: "path", value: "src/x.ts" }] },
      spec("s3", "Y", "# Y\n**Status**: Approved\nStatus: Draft\n", day(1)),
      { ...spec("s4", "Z", "Status: Draft", day(1)), refs: [{ kind: "spec", value: "specs/200-z" }] },
      { ...spec("s5", "W", "Status: Draft", day(1)), refs: [{ kind: "spec", value: "specs/300-w" }] },
      { seed: "w", provenance: "git_pr", body: prBody("W.", 4), at: day(2),
        refs: [{ kind: "spec", value: "specs/300-w" }, { kind: "path", value: "src/w.ts" }] },
    ]);
    await fx.sync(github, [
      { seed: "gh", provenance: "github_pr", at: day(8), refs: [{ kind: "spec", value: "specs/100-x" },
        { kind: "path", value: "src/y.ts" }, { kind: "status", value: "merged" }] },
      { seed: "gh-open", provenance: "github_pr", at: day(9), refs: [{ kind: "spec", value: "specs/100-x" },
        { kind: "path", value: "src/z.ts" }, { kind: "status", value: "open" }] },
    ]);
    const view = await conflicts({ rules: ["draft_spec_shipped"] });
    expect(view.items.map((item) => item.summary)).toEqual([
      "specs/100-x still reads Draft, but #3 and 1 later pull requests shipped work for it",
      "specs/300-w still reads Draft, but #4 shipped work for it",
    ]);
    expect(view.items[0]).toMatchObject({
      rule: "draft_spec_shipped", summary: "specs/100-x still reads Draft, but #3 and 1 later pull requests shipped work for it",
      sides: [{ claimId: null, statement: null, quote: "feat: ship X", cite: { label: "#3" } },
        { quote: "**Status:** Draft (v2)", cite: { label: "specs/100-x", kind: "spec" } }],
    });
    // Each Draft gets its share of the scan, and pull requests dated before it never fill it: #1 predates specs/100-x.
    (BRIEF_SCANS as { shippedPullRequests: number }).shippedPullRequests = 1;
    expect((await conflicts({ rules: ["draft_spec_shipped"] })).items.map((item) => item.summary)).toEqual([
      "specs/100-x still reads Draft, but #3 shipped work for it", "specs/300-w still reads Draft, but #4 shipped work for it",
    ]);
    (BRIEF_SCANS as { shippedPullRequests: number }).shippedPullRequests = 5_000;
    await fx.sync(git, [{ ...spec("s5", "W", "Status: Approved", day(10)), refs: [{ kind: "spec", value: "specs/300-w" }] }]);
    expect((await computeConflicts(fx.harness.db, BRIEF_SCOPE, ["draft_spec_shipped"], new Date(day(3)))).map((item) => item.summary)).toEqual(["specs/300-w still reads Draft, but #4 shipped work for it"]);
  });

  it("finds commitments marked done after being deferred, and the reverse", async () => {
    const git = await fx.source();
    await fx.sync(git, [
      { seed: "a", body: "Next steps: export API later.", at: day(1) },
      { seed: "b", body: "Next steps: export API shipped.", at: day(2) },
      { seed: "c", body: "Next steps: import tool is done.", at: day(3) },
      { seed: "d", body: "Next steps: import tool, deferred.", at: day(4) },
      { seed: "e", body: "Next steps: unrelated thing.", at: day(5), refs: [{ kind: "status", value: "done" }] },
    ]);
    await fx.extract("a", [{ kind: "commitment", statement: "export API later." }]);
    await fx.extract("b", [{ kind: "commitment", statement: "export API shipped." }]);
    await fx.extract("c", [{ kind: "commitment", statement: "import tool is done." }]);
    await fx.extract("d", [{ kind: "commitment", statement: "import tool, deferred." }]);
    await fx.extract("e", [{ kind: "commitment", statement: "unrelated thing." }]);
    const view = await conflicts({ rules: ["commitment_reversed", "label_disagreement"] });
    expect(view.items.map((item) => item.summary)).toEqual([
      "Title d defers what Title c marked done",
      "Title b marks done what Title a deferred",
    ]);
  });

  it("pages with an opaque cursor bound to the query", async () => {
    const git = await fx.source();
    const docs = [1, 2, 3].map((n) => ({ seed: `n${n}`, body: `Limits: at most ${n} jobs per owner.`, at: day(n) }));
    await fx.sync(git, docs);
    for (const [index, doc] of docs.entries()) {
      await fx.extract(doc.seed, [{ kind: "decision", label: "Limits", statement: `at most ${index + 1} jobs per owner.` }]);
    }
    const first = await conflicts({ limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await conflicts({ limit: 2, cursor: first.nextCursor! });
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items).toHaveLength(1);
    const foreign = await errorOf(conflicts({ limit: 2, cursor: first.nextCursor!, rules: ["label_disagreement"] }));
    expect(foreign).toMatchObject({ code: "invalid_request" });
    const encode = (value: string) => Buffer.from(value).toString("base64url");
    for (const cursor of ["!", encode("{"), encode("{\"v\":2}"), "a".repeat(600)]) {
      expect(await errorOf(conflicts({ cursor }))).toMatchObject({ code: "invalid_request" });
    }
    expect(await errorOf(conflicts({ limit: 51 }))).toMatchObject({ code: "invalid_request" });
    expect(await errorOf(conflicts({ rules: ["nope"] }))).toMatchObject({ code: "invalid_request" });
  });
  it("bounds pairs, conflicts per claim and conflicts per rule", async () => {
    const other = { ownerId: BRIEF_OWNER, scopeId: "personal:project:proj_b" };
    async function seed(scope: typeof other, docs: number, labels: number): Promise<void> {
      const source = await fx.source("git", "big", scope);
      const statement = (doc: number, line: number) => `at most ${doc * 50 + line + 1} runs per owner.`;
      const seeds = Array.from({ length: docs }, (_, doc) => `big${doc}`);
      await fx.sync(source, seeds.map((seedName, doc) => ({ seed: seedName,
        body: Array.from({ length: 50 }, (_, line) => `L${line % labels}: ${statement(doc, line)}`).join("\n") })), scope);
      for (const [doc, seedName] of seeds.entries()) {
        await fx.extract(seedName, Array.from({ length: 50 }, (_, line) => ({
          kind: "invariant" as const, label: `L${line % labels}`, statement: statement(doc, line),
        })), scope);
      }
    }
    await seed(BRIEF_SCOPE, 13, 13);
    const all = await computeConflicts(fx.harness.db, BRIEF_SCOPE, ["label_disagreement"]);
    expect(all).toHaveLength(500);
    const uses = new Map<string, number>();
    for (const side of all.flatMap((item) => item.sides)) uses.set(side.claimId!, (uses.get(side.claimId!) ?? 0) + 1);
    expect(Math.max(...uses.values())).toBe(3);
    await seed(other, 9, 2);
    const capped = await computeConflicts(fx.harness.db, other, ["label_disagreement"]);
    expect(capped.length).toBeGreaterThan(0);
    expect(new Set(capped.flatMap((item) => item.sides.map((side) => side.claimId))).size).toBeLessThanOrEqual(400);
  });

  it("compares at most 20,000 pairs per rule, the first rows of every group first", async () => {
    const git = await fx.source();
    const word = (n: number) => `w${String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26))}`;
    async function seed(label: string, text: string, docs: number, from: number): Promise<void> {
      const lines = (doc: number) => Array.from({ length: 25 }, (_, line) => `${text} ${word(doc * 25 + line)}.`);
      await fx.sync(git, Array.from({ length: docs }, (_, doc) => ({
        seed: `${label}${doc}`, at: day(from + doc), body: lines(doc).map((line) => `${label}: ${line}`).join("\n") })));
      for (let doc = 0; doc < docs; doc += 1) {
        await fx.extract(`${label}${doc}`, lines(doc).map((statement) => ({ kind: "decision" as const, label, statement })));
      }
    }
    await fx.sync(git, [{ seed: "old", at: day(1), body: "Ready: x is not ready for waa." }]);
    await fx.extract("old", [{ kind: "decision", label: "Ready", statement: "x is not ready for waa." }]);
    await seed("Ready", "x is ready for", 7, 10);
    expect(await computeConflicts(fx.harness.db, BRIEF_SCOPE, ["label_disagreement"])).toHaveLength(1);
    await seed("Set", "y is set for", 8, 2);
    expect(await computeConflicts(fx.harness.db, BRIEF_SCOPE, ["label_disagreement"])).toEqual([]);
  });

  it("drops conflicts and stale items whose document went away mid-read", async () => {
    const git = await fx.source();
    await fx.sync(git, [{ seed: "a", body: "S: x is ready." }, { seed: "b", body: "S: x is not ready." }]);
    await fx.extract("a", [{ kind: "decision", label: "S", statement: "x is ready." }]);
    await fx.extract("b", [{ kind: "decision", label: "S", statement: "x is not ready." }]);
    const dropCites: KyselyPlugin = {
      transformQuery: (args) => args.node,
      transformResult: async (args) => ({ ...args.result, rows: args.result.rows.filter((row) => !("body_tail" in row)) }),
    };
    const db = fx.harness.db.withPlugin(dropCites);
    expect(await computeConflicts(fx.harness.db, BRIEF_SCOPE, ["label_disagreement"])).toHaveLength(1);
    expect(await computeConflicts(db, BRIEF_SCOPE, ["label_disagreement"])).toEqual([]);
    const now = fx.harness.now();
    const { sections } = await buildSections(db, BRIEF_SCOPE, briefWindow(undefined, "day", now), now);
    expect([sections.changes[0]!.items, sections.decisions]).toEqual([[], []]);
    await fx.sync(git, [{ seed: "a", body: "S: x is ready, v2." }]);
    const options = { kinds: ["claim_outdated"] as const, now: fx.harness.now(), overdueBefore: "2026-10-01", before: null };
    expect(await computeStale(fx.harness.db, BRIEF_SCOPE, options)).toHaveLength(1);
    expect(await computeStale(db, BRIEF_SCOPE, options)).toEqual([]);
  });
});

describe("stale", () => {
  it("lists outdated claims, overdue commitments and failing or old sources", async () => {
    const git = await fx.source();
    const old = await fx.source("linear", "Quiet");
    await fx.sync(git, [
      { seed: "a", body: "Decision: v1." },
      { seed: "b", body: "Next steps: write docs.\nNext steps: ship it." },
      { seed: "c", body: "Next steps: closed item.", refs: [{ kind: "status", value: "canceled" }] },
    ]);
    await fx.extract("a", [{ kind: "decision", statement: "v1." }]);
    await fx.extract("b", [
      { kind: "commitment", statement: "write docs.", fields: { due: "2026-09-30", assignee: "Bo" } },
      { kind: "commitment", statement: "ship it.", fields: { due: "2026-10-30" } },
    ]);
    await fx.extract("c", [{ kind: "commitment", statement: "closed item.", fields: { due: "2026-09-01" } }]);
    await fx.receipt(git, "failed", "source_auth_failed");
    fx.harness.tick(1_000);
    await fx.receipt(old, "succeeded");
    fx.harness.tick(1_000);
    await fx.sync(git, [{ seed: "a", body: "Decision: v2." }]);
    fx.harness.tick(8 * 86_400_000);
    const view = await stale();
    expect(view.items.map((item) => [item.kind, item.since])).toEqual([
      ["source_sync_old", "2026-10-08T10:00:01.000Z"],
      ["source_sync_old", "2026-10-08T10:00:00.000Z"],
      ["claim_outdated", "2026-10-01T10:00:02.000Z"],
      ["source_failing", "2026-10-01T10:00:00.000Z"],
      ["commitment_overdue", "2026-10-01T00:00:00.000Z"],
    ]);
    expect(view.items.map((item) => item.text)).toEqual([
      "Source \"Quiet\" has not synced successfully since 2026-10-01",
      "Source \"matrix-os\" has not synced successfully since it was connected on 2026-10-01",
      "Outdated decision: v1.",
      "Source \"matrix-os\" failed its last sync (source_auth_failed)",
      "Overdue (due 2026-09-30): write docs.",
    ]);
    expect(view.items[2]).toMatchObject({ cite: { label: "Title a", revision: 2 }, sourceId: null });
    expect(view.items[0]).toMatchObject({ cite: null, claimId: null });
    expect((await stale({ kinds: ["commitment_overdue"], limit: 1 })).items).toHaveLength(1);
    expect((await stale({ kinds: ["claim_outdated"] })).items.map((item) => item.kind)).toEqual(["claim_outdated"]);
    const page = await stale({ limit: 2 });
    expect((await stale({ limit: 2, cursor: page.nextCursor! })).items).toHaveLength(2);
  });

  it("finds open commitments behind closed and finished ones that are due earlier", async () => {
    const linear = await fx.source("linear", "Linear ENG");
    const task = (seed: string, statement: string, due: string, status?: string) => ({
      seed, body: `Next steps: ${statement}`, statement,
      refs: [{ kind: "due", value: due }, ...(status === undefined ? [] : [{ kind: "status", value: status }])],
    });
    const tasks = [
      task("closed1", "rotate keys.", "2026-09-01", "done"), task("closed2", "write runbook.", "2026-09-01", "canceled"),
      task("closed3", "plan offsite.", "2026-09-01", "cancelled"), task("said1", "export shipped.", "2026-09-02"),
      task("said2", "import merged.", "2026-09-02"), task("said3", "login fixed.", "2026-09-02"),
      task("open1", "Ensure the migration is completed by Friday.", "2026-09-03"),
      task("open2", "write the guide.", "2026-09-04", "started"),
    ];
    await fx.sync(linear, tasks);
    for (const { seed, statement } of tasks) await fx.extract(seed, [{ kind: "commitment", statement }]);
    const read = async (limit: number) =>
      (await openCommitments(fx.harness.db, BRIEF_SCOPE, { limit, before: null })).map((row) => row.statement);
    expect(await read(2)).toEqual(["Ensure the migration is completed by Friday.", "write the guide."]);
    expect(await read(1)).toEqual(["Ensure the migration is completed by Friday."]);
    const overdue = await computeStale(fx.harness.db, BRIEF_SCOPE, {
      kinds: ["commitment_overdue"], now: fx.harness.now(), overdueBefore: "2026-10-01", before: null,
    });
    expect(overdue.map((item) => item.text)).toEqual([
      "Overdue (due 2026-09-04): write the guide.", "Overdue (due 2026-09-03): Ensure the migration is completed by Friday.",
    ]);
  });

  it("stops reading commitments after a bounded number of pages", async () => {
    const git = await fx.source();
    const statements = Array.from({ length: 11 }, (_, index) => `task ${index} shipped.`);
    await fx.sync(git, [{ seed: "many", body: statements.map((text) => `Next steps: ${text}`).join("\n") },
      { seed: "late", body: "Next steps: write the guide.", at: day(1) }]);
    await fx.extract("many", statements.map((statement) => ({ kind: "commitment" as const, statement })));
    await fx.extract("late", [{ kind: "commitment", statement: "write the guide." }]);
    expect(await openCommitments(fx.harness.db, BRIEF_SCOPE, { limit: 1, before: null })).toEqual([]);
    expect((await openCommitments(fx.harness.db, BRIEF_SCOPE, { limit: 2, before: null })).map((row) => row.statement))
      .toEqual(["write the guide."]);
  });
});
