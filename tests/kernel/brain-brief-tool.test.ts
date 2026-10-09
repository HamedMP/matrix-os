import { describe, expect, it, vi } from "vitest";
import { formatBrainBrief, renderBrainBrief } from "../../packages/kernel/src/tools/brain-brief.js";
import {
  brainReadToolDefinitions, type BrainBriefLine, type BrainBriefView,
} from "../../packages/kernel/src/tools/brain-read-tools.js";

const CITE = {
  documentId: "d".repeat(64), kind: "pr", label: "#7", title: "Ship it", permalink: "https://x.test/pull/7",
  date: "2026-10-01T09:00:00Z",
} as const;

const line = (overrides: Partial<BrainBriefLine> = {}): BrainBriefLine => ({
  text: "Decided to bound lists", cites: [CITE], due: null, assignee: null, severity: null, ...overrides,
});
const EMPTY = { changes: [], decisions: [], commitments: [], risks: [], attention: [] };
const view = (overrides: Partial<BrainBriefView> = {}): BrainBriefView => ({
  date: "2026-10-01", window: "day", sections: EMPTY, summary: null, truncated: false, ...overrides,
});

describe("brain_brief answer text", () => {
  it("lists sections in order with cites, extras, other cites and change groups", () => {
    const text = formatBrainBrief(view({
      summary: { text: "Quiet\nday." },
      sections: {
        attention: [line({ text: "Spec 544 is still Draft", cites: [
          CITE, { ...CITE, kind: "spec", label: "specs/544-x", permalink: "https://x.test/specs/544" },
          { ...CITE, kind: "commit", label: "abc1234", permalink: "" },
        ] })],
        decisions: [line()],
        commitments: [line({ text: "Write docs", due: "2026-10-03", assignee: "ana", cites: [{ ...CITE, permalink: "" }] })],
        risks: [line({ text: "Costs may rise", severity: "high", cites: [] })],
        changes: [{
          label: "git", created: 2, revised: 1,
          items: [line({ text: "PR #7 merged" }), line({ text: "No cite", cites: [] }), line({ text: "No link", cites: [{ ...CITE, permalink: "" }] })],
        }],
      },
    }));
    expect(text).toBe([
      "Brief for 2026-10-01 (day): 1 attention item, 1 decision, 1 open commitment, 1 risk, 1 changed source.",
      "Summary: Quiet day.",
      "Needs attention:",
      "1. Spec 544 is still Draft - PR #7 (2026-10-01)",
      "   https://x.test/pull/7",
      "   Also: Spec specs/544-x (2026-10-01)",
      "         https://x.test/specs/544",
      "   Also: Commit abc1234 (2026-10-01)",
      "Decisions:",
      "2. Decided to bound lists - PR #7 (2026-10-01)",
      "   https://x.test/pull/7",
      "Open commitments:",
      "3. Write docs (due 2026-10-03, assignee ana) - PR #7 (2026-10-01)",
      "Risks:",
      "4. Costs may rise (severity high)",
      "Changes:",
      "5. git: 2 new, 1 revised",
      "   - PR #7 merged - PR #7 (2026-10-01) https://x.test/pull/7",
      "   - No cite",
      "   - No link - PR #7 (2026-10-01)",
    ].join("\n"));
  });

  it("caps change items per group, notes cut sections and stays under the cap", () => {
    const many = Array.from({ length: 12 }, (_, index) => line({ text: `item ${index}` }));
    const grouped = formatBrainBrief(view({ window: "week", truncated: true, sections: { ...EMPTY, changes: [{ label: "g", created: 12, revised: 0, items: many }] } }));
    expect(grouped).toContain("Brief for 2026-10-01 (week): 0 attention items, 0 decisions, 0 open commitments, 0 risks, 1 changed source. Some sections were cut at their caps.");
    expect(grouped).toContain("   - item 9 - PR #7 (2026-10-01) https://x.test/pull/7\n   (+2 more)");
    const two = formatBrainBrief(view({ sections: { ...EMPTY, changes: [{ label: "a", created: 1, revised: 0, items: [] }, { label: "b", created: 0, revised: 1, items: [] }] } }));
    expect(two.split("\n").slice(1)).toEqual(["Changes:", "1. a: 1 new, 0 revised", "2. b: 0 new, 1 revised"]);
    const long = Array.from({ length: 50 }, () => line({ text: "x".repeat(400) }));
    const text = formatBrainBrief(view({ sections: { ...EMPTY, decisions: long, risks: long } }));
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(text.split("\n").at(-1)).toMatch(/^\d+ more lines were left out for length\.$/);
  });

  it("answers an empty brief plainly and wraps a brief with content through the handler", async () => {
    expect(renderBrainBrief(view())).toEqual({ text: "Nothing to report for 2026-10-01 (day).", external: false });
    expect(renderBrainBrief(view({ window: "week" })).text).toBe("Nothing to report for 2026-10-01 (week).");
    expect(renderBrainBrief(view({ summary: { text: "s" } })).external).toBe(true);
    const brief = vi.fn(async () => ({ status: "ok" as const, ...view({ sections: { ...EMPTY, decisions: [line()] } }) }));
    const [definition] = brainReadToolDefinitions({ brief });
    const result = await definition!.handler({ project: "p", date: "2026-10-01", window: "day" });
    expect(brief).toHaveBeenCalledWith({ project: "p", date: "2026-10-01", window: "day" });
    expect(result.content[0]!.text).toMatch(/^<<<EXTERNAL_UNTRUSTED_CONTENT>>>[\s\S]*Decisions:\n1\. Decided/);
  });
});
