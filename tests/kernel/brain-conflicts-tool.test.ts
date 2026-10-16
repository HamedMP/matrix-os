import { describe, expect, it, vi } from "vitest";
import { formatBrainConflicts, renderBrainConflicts } from "../../packages/kernel/src/tools/brain-conflicts.js";
import {
  brainReadToolDefinitions, type BrainConflictsView, type BrainConflictView,
} from "../../packages/kernel/src/tools/brain-read-tools.js";

const CITE = {
  documentId: "d".repeat(64), kind: "pr", label: "#9", title: "Use Postgres", permalink: "https://x.test/pull/9",
  date: "2026-09-01T00:00:00Z",
} as const;

const conflict = (overrides: Partial<BrainConflictView> = {}): BrainConflictView => ({
  rule: "label_disagreement", summary: "Storage: two statements differ",
  sides: [
    { cite: CITE, quote: "Store it in Postgres." },
    { cite: { ...CITE, kind: "spec", label: "specs/12-x", title: "Old", permalink: "" }, quote: "Store\nit in files." },
  ],
  ...overrides,
});
const view = (overrides: Partial<BrainConflictsView> = {}): BrainConflictsView => ({
  items: [conflict()], nextCursor: null, ...overrides,
});

describe("brain_conflicts answer text", () => {
  it("lists both sides with cites, permalinks and quotes", () => {
    expect(formatBrainConflicts(view())).toBe([
      "Conflicts: 1 found, newest first.",
      "1. Statements disagree: Storage: two statements differ",
      "   a) PR #9 - 2026-09-01 - Use Postgres",
      "      https://x.test/pull/9",
      '      "Store it in Postgres."',
      "   b) Spec specs/12-x - 2026-09-01 - Old",
      '      "Store it in files."',
    ].join("\n"));
  });

  it("names every rule, falls back for unknown ones and continues with the cursor", () => {
    const text = formatBrainConflicts(view({
      nextCursor: "c2",
      items: [conflict({ rule: "draft_spec_shipped" }), conflict({ rule: "commitment_reversed" }), conflict({ rule: "x" as never })],
    }));
    expect(text).toContain("1. Draft spec already shipped: ");
    expect(text).toContain("2. Commitment reversed: ");
    expect(text).toContain("3. Conflict: ");
    expect(text.split("\n").at(-1)).toBe('More: call brain_conflicts with cursor "c2".');
  });

  it("stays under the cap, answers none plainly and wraps through the handler", async () => {
    const long = conflict({ summary: "s".repeat(400), sides: [{ cite: CITE, quote: "q".repeat(300) }, { cite: CITE, quote: "r".repeat(300) }] });
    const text = formatBrainConflicts(view({ items: Array.from({ length: 20 }, () => long), nextCursor: "n" }));
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text.split("\n").at(-1)).toMatch(/^\d+ more conflicts were left out for length/);
    expect(renderBrainConflicts(view({ items: [] }))).toEqual({
      text: "No conflicts found in this project's current claims and specs.", external: false,
    });
    const conflicts = vi.fn(async () => ({ status: "ok" as const, ...view() }));
    const [definition] = brainReadToolDefinitions({ conflicts });
    const result = await definition!.handler({ project: "p", limit: 5, cursor: "c" });
    expect(conflicts).toHaveBeenCalledWith({ project: "p", limit: 5, cursor: "c" });
    expect(result.content[0]!.text).toMatch(/^<<<EXTERNAL_UNTRUSTED_CONTENT>>>[\s\S]*Conflicts: 1 found/);
  });
});
