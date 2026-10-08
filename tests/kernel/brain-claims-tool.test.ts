import { describe, expect, it, vi } from "vitest";
import { formatBrainClaims, renderBrainClaims } from "../../packages/kernel/src/tools/brain-claims.js";
import {
  brainReadToolDefinitions, type BrainClaimsView, type BrainClaimView,
} from "../../packages/kernel/src/tools/brain-read-tools.js";

const DOC = { kind: "pr", label: "#2041", title: "Bound sessions", permalink: "https://x.test/pull/2041", date: "2026-09-20T00:00:00Z" } as const;

const claim = (overrides: Partial<BrainClaimView> = {}): BrainClaimView => ({
  kind: "decision", label: "Sessions", statement: "Keep sessions bounded.", fields: {}, stale: false, document: DOC,
  ...overrides,
});
const view = (overrides: Partial<BrainClaimsView> = {}): BrainClaimsView => ({
  kind: null, path: null, match: null, items: [claim()], nextCursor: null, ...overrides,
});

describe("brain_claims answer text", () => {
  it("lists claims with the document, permalink and statement", () => {
    expect(formatBrainClaims(view())).toBe([
      "Claims: 1 claim, newest document first.",
      "1. Decision in PR #2041 - 2026-09-20 - Bound sessions",
      "   https://x.test/pull/2041",
      "   Sessions: Keep sessions bounded.",
    ].join("\n"));
  });

  it("names the kind and folder filter, fields, stale claims and the cursor", () => {
    const text = formatBrainClaims(view({
      kind: "commitment", path: "packages/gateway/src", match: "folder", nextCursor: "k1",
      items: [
        claim({ kind: "commitment", label: null, stale: true, fields: { due: "2026-10-03", assignee: "ana", severity: "high" } }),
        claim({ kind: "risk", document: { ...DOC, kind: "commit", label: "abc", permalink: "" } }),
        claim({ kind: "other" as never }),
      ],
    }));
    expect(text.split("\n")).toEqual([
      "Commitments for packages/gateway/src/: 3 claims, newest document first.",
      "1. Commitment in PR #2041 - 2026-09-20 - Bound sessions [stale]",
      "   https://x.test/pull/2041",
      "   Keep sessions bounded. (due 2026-10-03, assignee ana, severity high)",
      "2. Risk in Commit abc - 2026-09-20 - Bound sessions",
      "   Sessions: Keep sessions bounded.",
      "3. Claim in PR #2041 - 2026-09-20 - Bound sessions",
      "   https://x.test/pull/2041",
      "   Sessions: Keep sessions bounded.",
      'More: call brain_claims with cursor "k1".',
    ]);
    expect(formatBrainClaims(view({ path: "src/a.ts", match: "file_or_folder", kind: "other" as never }))).toMatch(/^Claims for src\/a\.ts: /);
  });

  it("stays under the cap, answers an empty list plainly and wraps through the handler", async () => {
    const long = claim({ statement: "s".repeat(1_000) });
    const text = formatBrainClaims(view({ items: Array.from({ length: 50 }, () => long), nextCursor: "n" }));
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text.split("\n").at(-1)).toMatch(/^\d+ more claims were left out for length; call again with limit \d+/);
    expect(renderBrainClaims(view({ items: [], kind: "risk", path: "src", match: "folder" }))).toEqual({
      text: "Risks for src/: none found. Claims come from the last extraction; newer documents appear after the next extraction run.",
      external: false,
    });
    const claims = vi.fn(async () => ({ status: "ok" as const, ...view() }));
    const [definition] = brainReadToolDefinitions({ claims });
    const result = await definition!.handler({ project: "p", kind: "decision", path: "src/", limit: 50 });
    expect(claims).toHaveBeenCalledWith({ project: "p", kind: "decision", path: "src/", limit: 50 });
    expect(result.content[0]!.text).toMatch(/^<<<EXTERNAL_UNTRUSTED_CONTENT>>>[\s\S]*1\. Decision in PR #2041/);
  });
});
