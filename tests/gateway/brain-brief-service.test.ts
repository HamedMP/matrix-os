import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainApiError } from "../../packages/gateway/src/brain/api/types.js";
import { BrainFeatureError, type BrainBriefSummaryModel } from "../../packages/gateway/src/brain/contracts.js";
import { readStoredBrief, writeStoredBrief } from "../../packages/gateway/src/brain/brief/database.js";
import { bootstrapBrainBriefDatabase, createBrainBrief } from "../../packages/gateway/src/brain/brief/index.js";
import { pickAttentionConflicts } from "../../packages/gateway/src/brain/brief/sections.js";
import { briefWindow } from "../../packages/gateway/src/brain/brief/time.js";
import { brainDocumentId } from "./helpers/brain-store-helpers.js";
import { BRIEF_OWNER, BRIEF_SCOPE, createBriefFixture, prBody, type BriefFixture } from "./helpers/brain-brief-fixture.js";

let fx: BriefFixture;
beforeEach(async () => {
  fx = await createBriefFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fx.destroy();
});

const brief = (query = {}) => fx.feature.service.getBrief(BRIEF_OWNER, "proj_a", query);
const errorOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

async function seedDay(): Promise<{ git: string; linear: string }> {
  const git = await fx.source();
  const linear = await fx.source("linear", "Linear ENG");
  await fx.sync(git, [
    { seed: "pr12", title: "feat: tokens", provenance: "git_pr", body: prBody("Decision: keep tokens in Postgres.\nRisk: migrations may lock.", 12) },
    { seed: "commit1", title: "chore: tidy", provenance: "git_commit", body: `Tidy.\n\nCommit: ${"b".repeat(40)}\nAuthor: Ada\nCommitted: x\nChanged paths: 1` },
    { seed: "spec1", title: "Spec one", provenance: "git_spec", body: "# Spec one\n\n**Status**: Approved\n", refs: [{ kind: "spec", value: "specs/001-one" }] },
    { seed: "old", title: "Old", provenance: "git_pr", at: "2026-09-28T08:00:00.000Z", body: prBody("Decision: old call.", 9) },
  ]);
  await fx.sync(linear, [{
    seed: "eng1", title: "Export API", provenance: "linear_issue", body: "Ship the export API by Friday.",
    refs: [{ kind: "handle", value: "ENG-1" }, { kind: "status", value: "started" }],
  }]);
  await fx.extract("pr12", [
    { kind: "decision", label: "Tokens", statement: "keep tokens in Postgres." },
    { kind: "risk", statement: "migrations may lock.", fields: { severity: "high" } },
  ]);
  await fx.extract("old", [{ kind: "decision", statement: "old call." }]);
  await fx.extract("eng1", [{ kind: "commitment", statement: "Ship the export API by Friday.", fields: { due: "2026-10-09", assignee: "Ada" } }]);
  return { git, linear };
}

describe("brief", () => {
  it("builds a cited day brief, stores it and serves the stored copy until it goes stale", async () => {
    await seedDay();
    await fx.harness.repository.upsertDocument(BRIEF_SCOPE, {
      documentId: brainDocumentId("note"), title: "Hand note", body: "Plain note.", permalink: "",
      sourceUpdatedAt: "2026-10-01T09:00:00.000Z", provenance: "matrix_note", sourceId: null,
    });
    const first = await brief();
    expect(first).toMatchObject({ date: "2026-10-01", window: "day", from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z", stored: true, truncated: false, summary: null });
    const groups = first.sections.changes;
    expect(groups.map((group) => [group.label, group.sourceKind, group.created, group.revised, group.items.length]))
      .toEqual([["matrix-os", "git", 3, 0, 3], ["Linear ENG", "linear", 1, 0, 1], ["Published by hand", null, 1, 0, 1]]);
    const labels = groups.flatMap((group) => group.items.map((item) => item.cites[0]!.label)).sort();
    expect(labels).toEqual(["#12", "ENG-1", "Hand note", "bbbbbbbbbbbb", "specs/001-one"]);
    expect(first.sections.decisions.map((line) => [line.text, line.claimKind, line.cites[0]!.kind]))
      .toEqual([["Tokens: keep tokens in Postgres.", "decision", "pr"]]);
    expect(first.sections.risks.map((line) => [line.text, line.severity])).toEqual([["migrations may lock.", "high"]]);
    expect(first.sections.commitments.map((line) => [line.text, line.due, line.assignee, line.cites[0]!.label]))
      .toEqual([["Ship the export API by Friday.", "2026-10-09", "Ada", "ENG-1"]]);
    fx.harness.tick(10 * 60_000);
    expect((await brief()).generatedAt).toBe(first.generatedAt);
    fx.harness.tick(2 * 3_600_000);
    const later = await brief({ date: "2026-10-01" });
    expect(later.generatedAt).not.toBe(first.generatedAt);
    const week = await brief({ window: "week" });
    expect(week.from).toBe("2026-09-25T00:00:00.000Z");
    expect(week.sections.decisions.map((line) => line.text)).toEqual(["Tokens: keep tokens in Postgres.", "old call."]);
  });

  it("sees the brain as it was at a past window's end and counts a note edited the day it was made as new", async () => {
    await seedDay();
    expect((await brief({ date: "2026-09-29" })).sections.commitments).toEqual([]);
    expect((await brief()).sections.commitments).toHaveLength(1);
    const notes = await fx.source("matrix_notes", "Notes");
    await fx.sync(notes, [{ seed: "n1", at: "2026-10-01T09:00:00.000Z" }]);
    await fx.sync(notes, [{ seed: "n1", body: "Edited.", at: "2026-10-01T09:30:00.000Z" }]);
    const day = await fx.feature.service.generateBrief(BRIEF_OWNER, "proj_a", {});
    expect(day.sections.changes.find((group) => group.label === "Notes")).toMatchObject({ created: 1, revised: 0 });
  });

  it("lists conflicts detected in the window first, then rotates the rest by day so each one shows", () => {
    const at = (n: number) => ({ detectedAt: `2026-09-${String(n).padStart(2, "0")}T08:00:00.000Z`, n });
    const items = Array.from({ length: 13 }, (_, i) => at(28 - i));
    const pick = (date: string) => pickAttentionConflicts(items, briefWindow(date, "day", new Date("2026-10-01T10:00:00Z")), 10)
      .map((item) => item.n);
    expect(pick("2026-09-27")[0]).toBe(27);
    const seen = new Set(["2026-09-29", "2026-09-30", "2026-10-01"].flatMap(pick));
    expect(seen.size).toBe(13);
  });

  it("lists only claims first seen in the window for revised documents", async () => {
    const git = await fx.source();
    await fx.sync(git, [{ seed: "spec", provenance: "git_spec", body: "Decision: use A." }]);
    await fx.extract("spec", [{ kind: "decision", statement: "use A." }]);
    fx.harness.tick(60_000);
    await fx.sync(git, [{ seed: "spec", provenance: "git_spec", body: "Decision: use A.\nDecision: use B." }]);
    fx.harness.tick(60_000);
    await fx.extract("spec", [{ kind: "decision", statement: "use A." }, { kind: "decision", statement: "use B." }]);
    expect((await brief()).sections.decisions.map((line) => line.text)).toEqual(["use B."]);
  });

  it("refuses dates in the future, too far back or not on the calendar", async () => {
    for (const date of ["2026-10-02", "2025-09-30", "2026-02-30", "x"]) {
      expect(await errorOf(brief({ date }))).toMatchObject({ code: "invalid_request" });
    }
    expect(await errorOf(brief({ window: "month" }))).toBeInstanceOf(BrainApiError);
    expect(await errorOf(fx.feature.service.getBrief(BRIEF_OWNER, "proj_other", {}))).toMatchObject({ code: "project_not_found" });
  });

  it("marks truncated sections and skips storing a brief over the byte cap", async () => {
    const git = await fx.source();
    const long = `https://example.com/${"p".repeat(2_000)}`;
    const docs = Array.from({ length: 52 }, (_, index) => ({
      seed: `d${index}`, provenance: "git_spec", permalink: long, title: "T".repeat(300),
      body: `Decision: choice ${index} ${"x".repeat(300)}\nNext steps: follow ${index} ${"y".repeat(300)}`,
    }));
    await fx.sync(git, docs);
    for (const [index, doc] of docs.entries()) {
      await fx.extract(doc.seed, [
        { kind: "decision", statement: `choice ${index} ${"x".repeat(300)}` },
        { kind: "commitment", statement: `follow ${index} ${"y".repeat(300)}` },
      ]);
    }
    for (let index = 0; index < 21; index += 1) {
      await fx.sync(await fx.source(`k${index}`, `Source ${index}`), [{ seed: `s${index}` }]);
    }
    const view = await brief();
    expect(view.truncated).toBe(true);
    expect(view.stored).toBe(false);
    expect(view.sections.changes).toHaveLength(20);
    expect(view.sections.decisions).toHaveLength(50);
    expect(view.sections.commitments).toHaveLength(50);
    expect(await readStoredBrief(fx.harness.db, BRIEF_SCOPE, "2026-10-01", "day")).toBeNull();
  });

  it("puts conflicts, overdue commitments, failing and old sources and outdated claims under attention", async () => {
    const git = await fx.source();
    const empty = await fx.source("linear", "Empty");
    await fx.sync(git, [
      { seed: "a", body: "Storage: tokens are stored in Postgres.", at: "2026-09-01T00:00:00.000Z" },
      { seed: "b", body: "Storage: tokens are never stored in Postgres." },
      { seed: "c", body: "Next steps: write the guide.", at: "2026-09-01T00:00:00.000Z" },
      { seed: "d", body: "Decision: v1." },
    ]);
    await fx.extract("a", [{ kind: "invariant", label: "Storage", statement: "tokens are stored in Postgres." }]);
    await fx.extract("b", [{ kind: "invariant", label: "Storage", statement: "tokens are never stored in Postgres." }]);
    await fx.extract("c", [{ kind: "commitment", statement: "write the guide.", fields: { due: "2026-09-10" } }]);
    await fx.extract("d", [{ kind: "decision", statement: "v1." }]);
    await fx.receipt(git, "failed", "source_auth_failed");
    await fx.receipt(empty, "failed");
    fx.harness.tick(1_000);
    await fx.sync(git, [{ seed: "d", body: "Decision: v2." }]);
    const lines = (await brief()).sections.attention;
    expect(lines.map((line) => line.text)).toEqual([
      expect.stringContaining("disagree on \"Storage\""),
      "Outdated decision: v1.",
      "Source \"matrix-os\" failed its last sync (source_auth_failed)",
      "Overdue (due 2026-09-10): write the guide.",
    ]);
    expect(lines[0]!.cites).toHaveLength(2);
    expect(lines[3]).toMatchObject({ claimKind: "commitment", due: "2026-09-10" });
  });

  it("reads a commitment's due date and assignee from its document's refs when the claim has none", async () => {
    const linear = await fx.source("linear", "Linear ENG");
    await fx.sync(linear, [
      { seed: "eng2", body: "Rotate the signing keys.", refs: [{ kind: "due", value: "2026-09-20" },
        { kind: "assignee", value: "linear:u1" }] },
      { seed: "eng3", body: "Write the runbook.", refs: [{ kind: "due", value: "soon" }] },
      { seed: "eng4", body: "Fix the login bug.", at: "2026-09-30T08:00:00.000Z", refs: [{ kind: "due", value: "2025-13-01" }] },
      { seed: "eng5", body: "Plan the offsite.", refs: [{ kind: "due", value: "2026-02-30" }, { kind: "due", value: "2026-09-25" }] },
    ]);
    for (const [seed, statement] of [["eng2", "Rotate the signing keys."], ["eng3", "Write the runbook."],
      ["eng4", "Fix the login bug."], ["eng5", "Plan the offsite."]]) {
      await fx.extract(seed!, [{ kind: "commitment", statement: statement! }]);
    }
    const view = await brief();
    expect(view.sections.commitments.map((line) => [line.text, line.due, line.assignee])).toEqual([
      ["Rotate the signing keys.", "2026-09-20", "linear:u1"], ["Plan the offsite.", "2026-09-25", null],
      ["Write the runbook.", null, null], ["Fix the login bug.", null, null]]);
    expect(view.sections.attention.map((line) => [line.text, line.due, line.assignee])).toEqual([
      ["Overdue (due 2026-09-25): Plan the offsite.", "2026-09-25", null],
      ["Overdue (due 2026-09-20): Rotate the signing keys.", "2026-09-20", "linear:u1"]]);
    const overdue = await fx.feature.service.stale(BRIEF_OWNER, "proj_a", { kinds: ["commitment_overdue"] });
    expect(overdue.items.map((item) => item.since)).toEqual(["2026-09-26T00:00:00.000Z", "2026-09-21T00:00:00.000Z"]);
    expect(JSON.stringify([view, overdue])).not.toMatch(/2025-13-01|2026-02-30/);
  });

  it("caps attention per kind, reads each claim once and skips unreadable fields", async () => {
    const git = await fx.source();
    const tasks = Array.from({ length: 21 }, (_, index) => `task ${index + 1}.`);
    await fx.sync(git, [{ seed: "many", body: tasks.map((task) => `Next steps: ${task}`).join("\n") },
      { seed: "bad", body: "Next steps: bad one." }]);
    const claims = tasks.map((statement) => ({ kind: "commitment" as const, statement, fields: { due: "2026-09-10" } }));
    await fx.extract("many", claims);
    // A model run holds the same claim ids (a newer rules version would replace the rules set instead).
    await fx.extract("many", claims, BRIEF_SCOPE, "model:claude-opus-5-5/claims-v2");
    await fx.extract("bad", [{ kind: "commitment", statement: "bad one.", fields: { due: "2026-09-11" } }]);
    await sql`UPDATE brain_claims SET fields = '{"due": "2026-09-11", "x": 1}'::jsonb WHERE statement = 'bad one.'`.execute(fx.harness.db);
    const view = await brief();
    expect(view.truncated).toBe(true);
    expect(view.sections.attention).toHaveLength(20);
    expect(view.sections.commitments).toHaveLength(22);
    const overdue = await fx.feature.service.stale(BRIEF_OWNER, "proj_a", { kinds: ["commitment_overdue"], limit: 50 });
    expect(overdue.items).toHaveLength(21);
    const plain = createBrainBrief({ repository: fx.harness.repository, resolver: fx.resolver });
    expect((await plain.service.stale(BRIEF_OWNER, "proj_a", { kinds: ["source_failing"] })).items).toEqual([]);
  });

  it("adds a model summary only when asked and configured", async () => {
    await seedDay();
    await fx.harness.repository.upsertDocument(BRIEF_SCOPE, {
      documentId: brainDocumentId("chat"), title: "Chat about tokens", body: "Decision: move tokens to Redis.",
      permalink: "", sourceUpdatedAt: "2026-10-01T09:00:00.000Z", provenance: "matrix_chat", sourceId: null,
    });
    await fx.extract("chat", [{ kind: "decision", statement: "move tokens to Redis." }]);
    const service = fx.feature.service;
    expect(await errorOf(service.generateBrief(BRIEF_OWNER, "proj_a", { summary: true })))
      .toBeInstanceOf(BrainFeatureError);
    const nullProvider = fx.rebuild(async () => null).service;
    expect(await errorOf(nullProvider.generateBrief(BRIEF_OWNER, "proj_a", { summary: true })))
      .toMatchObject({ code: "summary_not_configured" });
    const summarize = vi.fn<BrainBriefSummaryModel["summarize"]>(async () => ({
      text: `Busy day.\n${"z".repeat(2_000)}`, modelId: "model-x", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 },
    }));
    const withModel = fx.rebuild(async () => ({ summarize })).service;
    const view = await withModel.generateBrief(BRIEF_OWNER, "proj_a", { summary: true, window: "day" });
    expect(view.summary).toMatchObject({ modelId: "model-x", generatedAt: "2026-10-01T10:00:00.000Z" });
    expect(view.summary!.text.length).toBe(1_200);
    const sent = summarize.mock.calls[0]![0].lines;
    expect(sent).toEqual(["feat: tokens", "Spec one", "chore: tidy", "Tokens: keep tokens in Postgres.", "migrations may lock."]);
    expect(view.sections.decisions.map((line) => line.text)).toContain("move tokens to Redis.");
    expect((await brief()).summary).toEqual(view.summary);
    const plain = await withModel.generateBrief(BRIEF_OWNER, "proj_a", {});
    expect(plain.summary).toBeNull();
    summarize.mockResolvedValueOnce({ text: "  ", modelId: "m", usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } });
    expect(await errorOf(withModel.generateBrief(BRIEF_OWNER, "proj_a", { summary: true })))
      .toMatchObject({ code: "brain_unavailable" });
  });
});

describe("stored briefs", () => {
  it("keeps the newest copy, prunes past the per-scope cap and rebuilds unreadable rows", async () => {
    const base = await brief();
    expect(await writeStoredBrief(fx.harness.db, BRIEF_SCOPE, { ...base, generatedAt: "2026-10-01T09:00:00.000Z" })).toBe(false);
    expect((await readStoredBrief(fx.harness.db, BRIEF_SCOPE, base.date, "day"))!.generatedAt).toBe(base.generatedAt);
    for (let day = 0; day < 61; day += 1) {
      const date = new Date(Date.UTC(2026, 6, 1) + day * 86_400_000).toISOString().slice(0, 10);
      expect(await writeStoredBrief(fx.harness.db, BRIEF_SCOPE, { ...base, date })).toBe(true);
    }
    const count = await sql<{ n: number }>`SELECT count(*)::int AS n FROM brain_brief_briefs`.execute(fx.harness.db);
    expect(count.rows[0]!.n).toBe(60);
    expect(await writeStoredBrief(fx.harness.db, BRIEF_SCOPE, { ...base, date: "2026-07-01" })).toBe(false);
    expect((await brief({ date: "2026-03-01" })).stored).toBe(false);
    expect(await readStoredBrief(fx.harness.db, BRIEF_SCOPE, "2026-03-01", "day")).toBeNull();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sql`UPDATE brain_brief_briefs SET body = '{"date": 1}'::jsonb`.execute(fx.harness.db);
    expect((await brief()).stored).toBe(true);
    expect(error).toHaveBeenCalledWith("[brain-brief] Stored brief unreadable:", "ZodError");
    await bootstrapBrainBriefDatabase(fx.harness.db);
  });

  it("never serves a stored brief that cites a document deleted since, and drops that copy", async () => {
    const chat = await fx.source("matrix", "Chats");
    await fx.sync(chat, [{ seed: "pay", title: "Private chat: salary talk", body: "Decision: raise pay in May." }]);
    await fx.extract("pay", [{ kind: "decision", statement: "raise pay in May." }]);
    const final = { ...await brief(), generatedAt: "2026-10-02T00:00:00.000Z" };
    expect(final.sections.decisions.map((line) => line.text)).toEqual(["raise pay in May."]);
    expect(await writeStoredBrief(fx.harness.db, BRIEF_SCOPE, final)).toBe(true);
    const group = { ...final.sections.changes[0]!, items: [] };
    const groupOnly = { ...final, date: "2026-09-30", sections: { ...final.sections, decisions: [], changes: [group] } };
    expect(await writeStoredBrief(fx.harness.db, BRIEF_SCOPE, groupOnly)).toBe(true);
    const { revision } = (await fx.harness.repository.getSource(BRIEF_SCOPE, chat))!;
    await fx.harness.repository.deleteSource(BRIEF_SCOPE, { sourceId: chat, expectedRevision: revision });
    const after = await brief({ date: "2026-10-01" });
    const row = await readStoredBrief(fx.harness.db, BRIEF_SCOPE, "2026-10-01", "day");
    expect(JSON.stringify([after, row, await brief({ date: "2026-09-30" })])).not.toMatch(/salary|raise pay|Chats/);
    expect(after.sections.decisions).toEqual([]);
  });

  it("drops every stored copy citing a tombstoned document on documents_changed and on each scheduled pass", async () => {
    const chat = await fx.source("matrix", "Chats");
    await fx.sync(chat, [{ seed: "pay", title: "Salary chat", body: "Decision: raise pay in May." }]);
    await fx.extract("pay", [{ kind: "decision", statement: "raise pay in May." }]);
    const today = await brief();
    for (const date of ["2026-09-20", "2026-09-21"]) {
      expect(await writeStoredBrief(fx.harness.db, BRIEF_SCOPE, { ...today, date })).toBe(true);
    }
    const clean = { ...today, date: "2026-09-22", sections: { ...today.sections, changes: [], decisions: [] } };
    expect(await writeStoredBrief(fx.harness.db, BRIEF_SCOPE, clean)).toBe(true);
    await fx.harness.repository.applySyncBatch(BRIEF_SCOPE, {
      sourceId: chat, expectedCursor: "c1", nextCursor: "c2", upserts: [], deletions: [brainDocumentId("pay")],
    });
    const event = { type: "documents_changed", scope: BRIEF_SCOPE, sourceId: null, documentIds: null, at: "x" } as const;
    await fx.feature.listener.handle(event, new AbortController().signal);
    const left = await sql<{ brief_date: string }>`SELECT brief_date FROM brain_brief_briefs`.execute(fx.harness.db);
    expect(left.rows.map((row) => row.brief_date)).toEqual(["2026-09-22"]);
    expect(await writeStoredBrief(fx.harness.db, BRIEF_SCOPE, { ...today, date: "2026-09-21" })).toBe(false);
    await sql`INSERT INTO brain_brief_briefs SELECT owner_id, scope_id, '2026-09-21', brief_window, generated_at,
      jsonb_set(body, '{date}', '"2026-09-21"'), byte_count FROM brain_brief_briefs`.execute(fx.harness.db);
    await sql`UPDATE brain_brief_briefs SET body = jsonb_set(body, '{sections,risks}', ${JSON.stringify(
      today.sections.decisions)}::jsonb) WHERE brief_date = '2026-09-21'`.execute(fx.harness.db);
    const scopes = { listActiveScopes: async () => [BRIEF_SCOPE] };
    await fx.feature.runner({ ownerId: BRIEF_OWNER, now: fx.harness.now(), scopes, signal: new AbortController().signal });
    const after = await sql<{ body: unknown }>`SELECT body FROM brain_brief_briefs`.execute(fx.harness.db);
    expect(JSON.stringify(after.rows)).not.toMatch(/raise pay|Salary/);
  });

  it("deletes a scope's briefs on scope_erased and ignores other events", async () => {
    await brief();
    const { listener } = fx.feature;
    const signal = new AbortController().signal;
    await listener.handle({ type: "claims_changed", scope: BRIEF_SCOPE, extractor: "rules/v1", documentIds: null, at: "x" }, signal);
    expect(await readStoredBrief(fx.harness.db, BRIEF_SCOPE, "2026-10-01", "day")).not.toBeNull();
    await listener.handle({ type: "scope_erased", scope: BRIEF_SCOPE, at: "x" }, signal);
    expect(listener.name).toBe("brief");
    expect(await readStoredBrief(fx.harness.db, BRIEF_SCOPE, "2026-10-01", "day")).toBeNull();
  });
  it("does not store a brief built before its scope was erased once the listener ran", async () => {
    const { git } = await seedDay();
    const built = await brief();
    expect(built.stored).toBe(true);
    await fx.harness.repository.eraseScope(BRIEF_SCOPE);
    await fx.feature.listener.handle({ type: "scope_erased", scope: BRIEF_SCOPE, at: "x" }, new AbortController().signal);
    expect(await writeStoredBrief(fx.harness.db, BRIEF_SCOPE, built)).toBe(false);
    const group = { ...built.sections.changes[0]!, sourceId: git, items: [] };
    const empty = { decisions: [], commitments: [], risks: [], attention: [] };
    const groupOnly = { ...built, sections: { ...empty, changes: [group] } };
    expect(await writeStoredBrief(fx.harness.db, BRIEF_SCOPE, groupOnly)).toBe(false);
    expect(await readStoredBrief(fx.harness.db, BRIEF_SCOPE, "2026-10-01", "day")).toBeNull();
  });
});

describe("runner", () => {
  it("builds today's brief per scope, completes yesterday's copy and counts skips and failures", async () => {
    const other = { ownerId: BRIEF_OWNER, scopeId: "personal:project:proj_b" };
    const broken = { ownerId: "o".repeat(300), scopeId: "s" };
    const throwing = { ownerId: "o", get scopeId(): string { throw "boom"; } };
    const gone = { ownerId: BRIEF_OWNER, scopeId: "personal:project:proj_gone" };
    const scopes = { listActiveScopes: vi.fn(async () => [BRIEF_SCOPE, other, broken, throwing, gone]) };
    const signal = new AbortController().signal;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await writeStoredBrief(fx.harness.db, other, { ...(await brief()), date: "2026-09-30",
      generatedAt: "2026-09-30T06:00:00.000Z", from: "2026-09-30T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
    const run = (now = fx.harness.now()) => fx.feature.runner({ ownerId: BRIEF_OWNER, now, scopes, signal });
    expect(await run()).toEqual({ scopes: 5, built: 1, failed: 2, skipped: 2 });
    expect(await readStoredBrief(fx.harness.db, gone, "2026-10-01", "day")).toBeNull();
    expect(error).toHaveBeenCalledWith("[brain-brief] Scheduled brief failed:", "error");
    expect(error).toHaveBeenCalledWith("[brain-brief] Scheduled brief failed:", "UnknownError");
    expect((await readStoredBrief(fx.harness.db, other, "2026-09-30", "day"))!.generatedAt).toBe("2026-10-01T10:00:00.000Z");
    expect((await readStoredBrief(fx.harness.db, other, "2026-10-01", "day"))).not.toBeNull();
    expect(await run()).toEqual({ scopes: 5, built: 0, failed: 2, skipped: 3 });
    const aborted = AbortSignal.abort();
    expect(await fx.feature.runner({ ownerId: BRIEF_OWNER, now: fx.harness.now(), scopes, signal: aborted }))
      .toEqual({ scopes: 5, built: 0, failed: 0, skipped: 5 });
  });

  it("counts a scope as failed and builds nothing when its project lookup is down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = createBrainBrief({
      repository: fx.harness.repository, now: fx.harness.now,
      resolver: { ...fx.resolver, resolve: async () => { throw new BrainApiError("brain_unavailable"); } },
    });
    const scopes = { listActiveScopes: vi.fn(async () => [BRIEF_SCOPE]) };
    const signal = new AbortController().signal;
    expect(await down.runner({ ownerId: BRIEF_OWNER, now: fx.harness.now(), scopes, signal }))
      .toEqual({ scopes: 1, built: 0, failed: 1, skipped: 0 });
    expect(error).toHaveBeenCalledWith("[brain-brief] Scheduled brief failed:", "BrainApiError");
    expect(await readStoredBrief(fx.harness.db, BRIEF_SCOPE, "2026-10-01", "day")).toBeNull();
  });
});
