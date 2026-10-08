import { describe, expect, it, vi } from "vitest";
import { formatBrainImpact, renderBrainImpact } from "../../packages/kernel/src/tools/brain-impact.js";
import { brainReadToolDefinitions, type BrainImpactView } from "../../packages/kernel/src/tools/brain-read-tools.js";

const CITE = {
  documentId: "d".repeat(64), kind: "pr", label: "#5", title: "Bound it", permalink: "https://x.test/pull/5",
  date: "2026-08-01T00:00:00Z",
} as const;
const SHA = "a".repeat(40);

const view = (overrides: Partial<BrainImpactView> = {}): BrainImpactView => ({
  base: { ref: "main", sha: SHA }, head: { ref: "feature/x", sha: "b".repeat(40) },
  changedFiles: [
    { path: "src/a.ts", status: "modified", previousPath: null, isTest: false },
    { path: "src/b.ts", status: "renamed", previousPath: "src/old.ts", isTest: false },
    { path: "tests/a.test.ts", status: "added", previousPath: null, isTest: true },
    { path: "src/c.ts", status: "copied" as never, previousPath: null, isTest: false },
  ],
  changedTotal: 4,
  dependents: [{ path: "src/main.ts", depth: 1, via: "src/a.ts" }, { path: "src/app.ts", depth: 2, via: "src/main.ts" }],
  prior: [{ path: "src/a.ts", items: [CITE, { ...CITE, label: "#3", permalink: "" }] }],
  invariants: [{ kind: "invariant", label: "Bounds", statement: "Lists stay bounded.", paths: ["src/a.ts"], cite: CITE }],
  decisions: [{ kind: "decision", label: null, statement: "Use Postgres.", paths: [], cite: { ...CITE, permalink: "" } }],
  untested: [{ path: "src/b.ts" }],
  specs: [
    { spec: "specs/544-x", changedPaths: ["specs/544-x/spec.md"], cite: { ...CITE, kind: "spec", label: "specs/544-x", title: "Store" } },
    { spec: "specs/545-y", changedPaths: ["a", "b"], cite: null },
  ],
  notices: [],
  ...overrides,
});

describe("brain_impact answer text", () => {
  it("lists sections in review order with cites and approximate importers", () => {
    expect(formatBrainImpact(view())).toBe([
      "Impact of feature/x (bbbbbbbbbbbb) against main (aaaaaaaaaaaa): 4 changed files, 2 importers (approximate), " +
        "1 invariant, 1 decision, 2 specs, 1 without a changed test.",
      "Invariants to keep:",
      "1. Bounds: Lists stay bounded. - PR #5 (2026-08-01)",
      "   https://x.test/pull/5",
      "   Paths: src/a.ts",
      "Decisions that apply:",
      "2. Use Postgres. - PR #5 (2026-08-01)",
      "Specs touched:",
      "- specs/544-x (1 changed file): Spec specs/544-x - 2026-08-01 - Store",
      "   https://x.test/pull/5",
      "- specs/545-y (2 changed files)",
      "Changed sources without a changed test:",
      "- src/b.ts",
      "Earlier pull requests:",
      "- src/a.ts: PR #5 (2026-08-01) https://x.test/pull/5; PR #3 (2026-08-01)",
      "Changed files:",
      "- M src/a.ts",
      "- R src/b.ts (from src/old.ts)",
      "- A tests/a.test.ts [test]",
      "- ? src/c.ts",
      "Importers (approximate):",
      "- src/main.ts imports src/a.ts",
      "- src/app.ts imports src/main.ts (second hop)",
    ].join("\n"));
  });

  it("explains notices, stays under the cap and drops the last sections first", () => {
    const files = Array.from({ length: 500 }, (_, index) => ({ path: `src/file-${index}-${"x".repeat(40)}.ts`, status: "added" as const, previousPath: null, isTest: false }));
    const text = formatBrainImpact(view({
      changedFiles: files, changedTotal: 900,
      notices: ["changed_files_capped", "dependents_capped", "scan_capped", "read_budget_exhausted", "run_budget_exhausted", "no_git_source", "brain_behind_head", "other" as never],
    }));
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text.split("\n")[1]).toBe(
      "Notes: only the first 500 changed files were read; the importer list was capped; the import scan stopped at " +
        "its file cap; the import scan stopped at its read budget; the run stopped at its time budget; the project has " +
        "no git source, so there is no history; the brain has not synced the newest commits yet; other.",
    );
    expect(text).toContain("Invariants to keep:");
    expect(text).not.toContain("Importers (approximate):");
    expect(text.split("\n").at(-1)).toMatch(/^\d+ more lines were left out for length\.$/);
  });

  it("answers an empty range and wraps through the handler", async () => {
    expect(renderBrainImpact(view({ changedTotal: 0, changedFiles: [] }))).toEqual({
      text: "No changes between main (aaaaaaaaaaaa) and feature/x (bbbbbbbbbbbb).", external: true,
    });
    const impact = vi.fn(async () => ({ status: "ok" as const, ...view() }));
    const [definition] = brainReadToolDefinitions({ impact });
    const result = await definition!.handler({ project: "p", head: "feature/x", base: "main", depth: 2 });
    expect(impact).toHaveBeenCalledWith({ project: "p", head: "feature/x", base: "main", depth: 2 });
    expect(result.content[0]!.text).toMatch(/^<<<EXTERNAL_UNTRUSTED_CONTENT>>>[\s\S]*Impact of feature\/x/);
    // The gateway's default depth is 2 (BRAIN_IMPACT_LIMITS.depthDefault); the model is told so.
    expect((definition!.inputShape.depth as { description?: string } | undefined)?.description).toBe(
      "Importer depth: 1 or 2 (default 2; depth-2 files fill the slots depth-1 files leave)",
    );
  });
});
