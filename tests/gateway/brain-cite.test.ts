/**
 * The shared cite rule every feature uses (brain/cite.ts) and the bounds for feature work on the owner pool
 * (brain/bounded.ts): read-only reads with a statement deadline and the in-process call cap.
 */
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBrainRead, brainCallCap } from "../../packages/gateway/src/brain/bounded.js";
import {
  brainCite, brainCiteKind, loadBrainCites, type BrainCiteInput,
} from "../../packages/gateway/src/brain/cite.js";
import { brainDocumentId, createBrainHarness, scopeA, type BrainHarness } from "./helpers/brain-store-helpers.js";

const base: Omit<BrainCiteInput, "provenance"> = {
  documentId: "d".repeat(64), sourceId: null, title: "feat: alpha", permalink: "", date: "2026-10-01T00:00:00Z",
  revision: 1, bodyTail: null, handle: null, spec: null,
};
const footer = (extra: string) => `body\n\nCommit: ${"a".repeat(40)}\n${extra}Changed paths: 1`;

describe("brain cite label", () => {
  it("labels by git footer, then handle, then a spec's first spec ref, then title", () => {
    const label = (overrides: Partial<typeof base> & { provenance: string }) => brainCite({ ...base, ...overrides }).label;
    expect(label({ provenance: "git_pr", bodyTail: footer("Pull request: #12\n") })).toBe("#12");
    expect(label({ provenance: "git_pr", bodyTail: footer("Merge request: !7\n") })).toBe("!7");
    expect(label({ provenance: "git_pr", bodyTail: footer("Author: A\n") })).toBe("a".repeat(12));
    expect(label({ provenance: "git_commit", bodyTail: footer("") })).toBe("a".repeat(12));
    expect(label({ provenance: "git_pr", bodyTail: "no footer", handle: "#9" })).toBe("PR");
    expect(label({ provenance: "git_commit" })).toBe("commit");
    expect(label({ provenance: "github_pr", handle: "#9", spec: "specs/x" })).toBe("#9");
    expect(label({ provenance: "git_spec", spec: "specs/549-x" })).toBe("specs/549-x");
    expect(label({ provenance: "git_spec" })).toBe("feat: alpha");
    expect(label({ provenance: "manual", title: `${"t".repeat(119)}\u{1F600}` })).toHaveLength(119);
    expect(label({ provenance: "manual", title: "t".repeat(200) })).toHaveLength(120);
    expect(brainCite({ ...base, provenance: "linear_issue", handle: "ENG-1" })).toEqual({
      documentId: base.documentId, kind: "issue", provenance: "linear_issue", sourceId: null, label: "ENG-1",
      title: "feat: alpha", permalink: "", date: "2026-10-01T00:00:00.000Z", revision: 1,
    });
    expect([brainCiteKind("custom"), brainCiteKind("toString"), brainCiteKind("git_spec")])
      .toEqual(["document", "document", "spec"]);
  });
});

describe("brain cite loader and bounds", () => {
  let harness: BrainHarness;
  beforeEach(async () => {
    harness = await createBrainHarness();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.destroy();
  });

  it("loads live documents' cites with their handle and spec refs, never tombstoned or foreign ones", async () => {
    const { source } = await harness.repository.createSource(scopeA, { kind: "git", externalRef: "r", label: "R" });
    const doc = (seed: string, provenance: string, body: string, refs: { kind: string; value: string }[] = []) => ({
      documentId: brainDocumentId(seed), title: `T ${seed}`, body, permalink: "", sourceUpdatedAt: "2026-10-01T00:00:00Z",
      provenance, refs,
    });
    await harness.repository.applySyncBatch(scopeA, {
      sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", deletions: [], upserts: [
        doc("pr", "git_pr", `${"x".repeat(5_000)}${footer("Pull request: #4\n")}`),
        doc("spec", "git_spec", "Spec.", [{ kind: "spec", value: "specs/002-b" }, { kind: "spec", value: "specs/001-a" }]),
        doc("gone", "matrix_note", "Gone."),
      ],
    });
    await harness.repository.applySyncBatch(scopeA, {
      sourceId: source.sourceId, expectedCursor: "c1", nextCursor: "c2", upserts: [], deletions: [brainDocumentId("gone")],
    });
    const ids = ["pr", "spec", "gone", "missing"].map(brainDocumentId);
    const cites = await loadBrainCites(harness.db, scopeA, ids);
    expect([...cites.values()].map((cite) => cite.label).sort()).toEqual(["#4", "specs/001-a"]);
    expect((await loadBrainCites(harness.db, { ...scopeA, scopeId: "other" }, ids)).size).toBe(0);
  });

  it("reads in one read-only transaction with a statement deadline, and caps heavy calls", async () => {
    const seen = await withBrainRead(harness.db, async (trx) => [
      (await sql<{ v: string }>`SELECT current_setting('statement_timeout') AS v`.execute(trx)).rows[0]!.v,
      (await sql<{ v: string }>`SELECT current_setting('transaction_read_only') AS v`.execute(trx)).rows[0]!.v,
    ]);
    expect(seen).toEqual(["10s", "on"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cap = brainCallCap("test call", 1);
    let release: () => void = () => undefined;
    const first = cap(() => new Promise<string>((resolve) => { release = () => resolve("done"); }));
    await expect(cap(async () => "second")).rejects.toMatchObject({ code: "brain_unavailable" });
    expect(warn).toHaveBeenCalledWith("[brain] test call refused: 1 already running");
    release();
    expect(await first).toBe("done");
    expect(await cap(async () => "again")).toBe("again");
  });
});
