import { describe, expect, it, vi } from "vitest";
import { formatBrainTimeline, renderBrainTimeline } from "../../packages/kernel/src/tools/brain-timeline.js";
import {
  brainReadToolDefinitions, type BrainTimelineItemView, type BrainTimelineView,
} from "../../packages/kernel/src/tools/brain-read-tools.js";

const CITE = {
  documentId: "d".repeat(64), kind: "commit", label: "1a2b3c4d5e6f", title: "Add the store", permalink: "https://x.test/c/1",
  date: "2026-09-27T10:00:00.000Z",
} as const;
const FRESH = { caughtUp: true, pendingDocuments: 0, pendingCapped: false };

const item = (overrides: Partial<BrainTimelineItemView> = {}): BrainTimelineItemView => ({
  cite: CITE, linkTypes: ["authored", "changed"], mode: "explicit", matchedPaths: ["src/a.ts"], ...overrides,
});
const view = (overrides: Partial<BrainTimelineView> = {}): BrainTimelineView => ({
  entity: { kind: "pull_request", key: "12", displayName: "#12 Bound it" },
  items: [item(), item({ mode: "inferred", linkTypes: ["implements_spec"], matchedPaths: [], cite: { ...CITE, kind: "pr", label: "#12", permalink: "" } })],
  nextCursor: null, freshness: FRESH, ...overrides,
});

describe("brain_timeline answer text", () => {
  it("lists items newest first with how each is linked", () => {
    expect(formatBrainTimeline(view())).toBe([
      "Timeline of pull request #12 Bound it: 2 items, newest first.",
      "1. Commit 1a2b3c4d5e6f - 2026-09-27 - Add the store",
      "   https://x.test/c/1",
      "   Linked: authored, changed; paths: src/a.ts",
      "2. PR #12 - 2026-09-27 - Add the store [inferred]",
      "   Linked: implements spec",
    ].join("\n"));
  });

  it("shows paths without link types, the key without a display name, freshness and the cursor", () => {
    const text = formatBrainTimeline(view({
      entity: { kind: "file", key: "src/a.ts", displayName: "" }, items: [item({ linkTypes: [] }), item({ linkTypes: [], matchedPaths: [] })],
      nextCursor: "t1", freshness: { caughtUp: false, pendingDocuments: 3, pendingCapped: false },
    }));
    expect(text.split("\n")).toEqual([
      "Timeline of file src/a.ts: 2 items, newest first. The index is catching up (3 documents pending).",
      "1. Commit 1a2b3c4d5e6f - 2026-09-27 - Add the store",
      "   https://x.test/c/1",
      "   Linked: related; paths: src/a.ts",
      "2. Commit 1a2b3c4d5e6f - 2026-09-27 - Add the store",
      "   https://x.test/c/1",
      'More: call brain_timeline with cursor "t1".',
    ]);
    expect(formatBrainTimeline(view({ items: [item()] }))).toMatch(/: 1 item, newest first\./);
  });

  it("keeps the answer under the cap and wraps even the empty answer (entity names are document text)", async () => {
    const long = item({ cite: { ...CITE, title: "t".repeat(400) }, matchedPaths: ["p".repeat(300), "q".repeat(300), "r".repeat(300)] });
    const text = formatBrainTimeline(view({ items: Array.from({ length: 30 }, () => long), nextCursor: "n" }));
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text.split("\n").at(-1)).toMatch(/^\d+ more items were left out for length/);
    expect(renderBrainTimeline(view({ items: [] }))).toEqual({
      text: "Nothing in the Company Brain touches pull request #12 Bound it yet.", external: true,
    });
    const timeline = vi.fn(async () => ({ status: "ok" as const, ...view() }));
    const [definition] = brainReadToolDefinitions({ timeline });
    const result = await definition!.handler({ project: "proj_1", entity: "pull_request:12", limit: 30, cursor: "c" });
    expect(timeline).toHaveBeenCalledWith({ project: "proj_1", entity: "pull_request:12", limit: 30, cursor: "c" });
    expect(result.content[0]!.text).toMatch(/^<<<EXTERNAL_UNTRUSTED_CONTENT>>>[\s\S]*Timeline of pull request/);
  });
});
