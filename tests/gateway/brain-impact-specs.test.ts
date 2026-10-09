/**
 * Impact brief spec cites: a spec folder may index several files (spec.md, plan.md, research.md, data-model.md,
 * quickstart.md), and the brief cites its spec.md first, else its newest live git_spec document. A file split into
 * parts is cited by part 1.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { specCites } from "../../packages/gateway/src/brain/impact/brain.js";
import { createBrainHarness, scopeA, scopeB, type BrainHarness } from "./helpers/brain-store-helpers.js";

let harness: BrainHarness;

beforeEach(async () => {
  harness = await createBrainHarness();
});

afterEach(async () => {
  await harness.destroy();
});

const docId = (n: number): string => n.toString(16).padStart(64, "0");

function specDoc(n: number, file: string, at: string, provenance = "git_spec", title = file) {
  const folder = file.slice(0, file.lastIndexOf("/"));
  return {
    documentId: docId(n), title, body: `Body of ${title}.`, permalink: "", sourceUpdatedAt: at, provenance,
    refs: [{ kind: "path", value: file }, { kind: "spec", value: folder }],
  };
}

describe("impact spec cites", () => {
  it("cites a folder's spec.md before its newer plan, else the newest file", async () => {
    const { source } = await harness.repository.createSource(scopeA, { kind: "git", externalRef: "w", label: "W" });
    await harness.repository.applySyncBatch(scopeA, {
      sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", deletions: [], upserts: [
        specDoc(1, "specs/001-a/spec.md", "2026-01-01T00:00:00.000Z"),
        specDoc(2, "specs/001-a/plan.md", "2026-03-01T00:00:00.000Z"),
        specDoc(3, "specs/002-b/research.md", "2026-01-01T00:00:00.000Z"),
        specDoc(4, "specs/002-b/plan.md", "2026-02-01T00:00:00.000Z"),
        specDoc(5, "specs/003-c/spec.md", "2026-04-01T00:00:00.000Z", "manual"),
        specDoc(6, "specs/003-c/plan.md", "2026-01-01T00:00:00.000Z"),
      ],
    });
    const cites = await specCites(harness.db, scopeA, ["specs/001-a", "specs/002-b", "specs/003-c", "specs/004-d"]);
    expect([...cites].map(([spec, cite]) => [spec, cite.documentId])).toEqual([
      ["specs/001-a", docId(1)], ["specs/002-b", docId(4)], ["specs/003-c", docId(6)],
    ]);
    expect(await specCites(harness.db, scopeB, ["specs/001-a"])).toEqual(new Map());
  });

  it("cites part 1 of a split file, whatever the part ids", async () => {
    const { source } = await harness.repository.createSource(scopeA, { kind: "git", externalRef: "w", label: "W" });
    const at = "2026-02-01T00:00:00.000Z";
    await harness.repository.applySyncBatch(scopeA, {
      sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", deletions: [], upserts: [
        specDoc(1, "specs/001-a/spec.md", at, "git_spec", "A (part 1 of 2)"),
        specDoc(2, "specs/001-a/spec.md", at, "git_spec", "A (part 2 of 2)"),
        specDoc(3, "specs/001-a/plan.md", "2026-03-01T00:00:00.000Z"),
        specDoc(4, "specs/002-b/research.md", "2026-01-01T00:00:00.000Z"),
        specDoc(5, "specs/002-b/plan.md", at, "git_spec", "B plan (part 1 of 12)"),
        specDoc(6, "specs/002-b/plan.md", at, "git_spec", "B plan (part 12 of 12)"),
        specDoc(7, "specs/002-b/plan.md", at, "git_spec", "B plan (part 2 of 12)"),
        specDoc(8, "specs/003-c/spec.md", at, "git_spec", "C (part 1 of 11)"),
        specDoc(9, "specs/003-c/spec.md", at, "git_spec", "C (part 11 of 11)"),
        specDoc(10, "specs/003-c/spec.md", at, "git_spec", "C (part 10 of 11)"),
      ],
    });
    const cites = await specCites(harness.db, scopeA, ["specs/001-a", "specs/002-b", "specs/003-c"]);
    expect([...cites].map(([spec, cite]) => [spec, cite.documentId])).toEqual([
      ["specs/001-a", docId(1)], ["specs/002-b", docId(5)], ["specs/003-c", docId(8)],
    ]);
  });
});
