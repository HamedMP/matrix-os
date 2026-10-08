/** Rules extractor claims. Fixtures are lines copied from real merged bodies (`git log -1 --format=%B <sha>`), trimmed. */
import { describe, expect, it } from "vitest";
import { claimSourceText, extractRulesClaims } from "../../packages/gateway/src/brain/claims/rules.js";
import { computeBrainClaimId, type BrainClaimExtraction } from "../../packages/gateway/src/brain/claims/types.js";
import { GIT_TRUNCATION_MARKER } from "../../packages/gateway/src/brain/git/index.js";

const DOC = "d".repeat(64);
const FOOTER = [`Commit: ${"a".repeat(40)}`, "Author: A", "Committed: 2026-09-01T00:00:00Z", "Pull request: #12",
  "Changed paths: 2"].join("\n");
const md = (...lines: string[]): string => lines.join("\n");

/** Extracts and checks the properties every claim must have: verbatim quote at its span, prefix text, stable id. */
function run(body: string, provenance = "git_pr", maxClaims?: number): BrainClaimExtraction {
  const result = extractRulesClaims({ documentId: DOC, provenance, title: "T", body }, maxClaims);
  const text = claimSourceText({ provenance, body });
  for (const claim of result.claims) {
    expect(body.slice(claim.spanStart, claim.spanEnd)).toBe(claim.quote);
    expect(claim.spanEnd).toBeLessThanOrEqual(text.length);
    expect(claim.claimId).toBe(computeBrainClaimId(DOC, claim.kind, claim.label, claim.statement));
  }
  expect(new Set(result.claims.map((claim) => claim.claimId)).size).toBe(result.claims.length);
  return result;
}

/** [kind, label, confidence, statement], by span then kind. */
const rows = (body: string, provenance?: string) => [...run(body, provenance).claims]
  .sort((a, b) => a.spanStart - b.spanStart || a.kind.localeCompare(b.kind))
  .map((claim) => [claim.kind, claim.label, claim.confidence, claim.statement]);
const kinds = (body: string, provenance?: string) => rows(body, provenance).map((row) => `${row[0]}:${row[1]}`);

describe("rules on real pull request bodies", () => {
  it("reads bold labels with the colon inside (6c190bf8e6 #2035); a pure exclusion list is no commitment", () => {
    expect(rows(md(
      "## Validation", "", "- Fresh exact-head Greptile and Linux CI are required before merge.", "", "## Invariants", "",
      "- **Source of truth:** saved owner-scoped Agent/Gmail binding, fresh native Hermes selection and exact bounded credential files; Jev uses the existing funded policy/ledger.",
      "- **Lock/transaction scope:** generated-default reconciliation uses the existing serialized Settings store and atomic owner-file persistence.",
      "- **Acceptable orphan states:** private profiles are deleted on confirmed exit; interrupted runs retain bounded cleanup ownership.",
      "- **Auth source of truth:** authenticated owner plus run-scoped sole-broker capability; no renderer-supplied payer, endpoint, account identity or credential.",
      "- **Deferred scope:** Codex/other harness bots, custom endpoints/named profiles, ambiguous pools, other OAuth and managed primary-model adapters, Gmail writes and public-site documentation. No universal provider-support claim.",
    )).map((row) => row[1])).toEqual(["Source of truth", "Lock/transaction scope", "Acceptable orphan states",
      "Auth source of truth", "Deferred scope"]);
  });

  it("reads the colon outside the bold and keeps a non-trivial `unchanged.` (3f4ec7b90c #2041); skips tables", () => {
    const body = md("## Invariants", "",
      "- **Source of truth**: the OS process table. A build timeout is reported only after the build's process group no longer exists.",
      "- **Auth source of truth**: unchanged. There are no auth changes.", "| Surface | UI |", "| --- | --- |",
      "| Web Canvas | N/A |", "![screenshot](shot.png)", "- **Resource bounds:** none.");
    const result = rows(body);
    expect([...result.map((row) => row[1]), result[1]![3]])
      .toEqual(["Source of truth", "Auth source of truth", "unchanged. There are no auth changes."]);
  });

  it("inherits labels from ### sub-headings (81e45c6132 #2039) and label-only parent bullets (6b7ebbe11d #2027)", () => {
    expect(kinds(md("## Invariants", "", "### Source of truth", "",
      "- Platform PostgreSQL/Kysely remains authoritative for exact owner/computer policy and funding.", "",
      "### Lock/transaction scope", "", "- Existing conditional probe-budget UPSERT and checkout claim transactions are unchanged.",
      "- Existing coalescing, 32-waiter/model and 128-key caps are preserved.", "", "## Review and CI", "",
      "Greptile reviewed exact head and scored it 5/5.")))
      .toEqual(["invariant:Source of truth", "invariant:Lock/transaction scope", "invariant:Lock/transaction scope"]);
    expect(rows(md("## Invariants",
      "- **Acceptable orphan states:**", "  - Validation happens before upload, so a bad value leaves nothing behind.",
      "  - A failed PR-close teardown leaves Private Previews until the daily reaper or the platform's 72-hour sweep.",
      "- **Deferred scope:** The computers list and OS view rendering (layer 5b).",
      "- **Deferred:** Adding `preview-collaboration` to a PR that already has a shared preview VPS fails the never-reassign-owner check. This PR changes neither behaviour. Follow-up: #2046.",
    )).map((row) => row.slice(0, 3).join(" "))).toEqual(["invariant Acceptable orphan states high",
      "invariant Acceptable orphan states high", "commitment Deferred scope medium", "commitment Deferred scope medium"]);
  });

  it("reads plain labels (5530d62c73 #2063) and a single labelled paragraph (4e84c0630c #1607)", () => {
    expect(rows(md("## Invariants", "",
      "- Source of truth: operator-configured MATRIX_APP_ORIGIN, falling back to the build-time NEXT_PUBLIC_MATRIX_APP_URL.",
      "- Lock / transaction scope: no database writes; header changes are scoped to one request and restored in finally.",
      "- Composition boundary: auth-shell body policy lives in a focused transport helper; the large session router delegates to it.",
      "- Acceptable orphan states: none introduced.",
      "- Deferred scope: preview computer identity/control-credential routing and the remaining Spec 535 acceptance journey.",
    )).map((row) => row.slice(1, 3))).toEqual([["Source of truth", "high"], ["Lock/transaction scope", "high"], [null, "medium"],
      ["Deferred scope", "high"]]);
    expect(rows(md("## Invariants", "",
      "Source of truth: shared saved-agent schemas and canonical Chat transport. The gateway owns revision validation.",
    ))).toEqual([["invariant", "Source of truth", "high",
      "shared saved-agent schemas and canonical Chat transport. The gateway owns revision validation."]]);
  });

  it("makes a commitment, not an invariant, of deferred items that point at later work (a899b98a2e #1999, 558e302608 #1935)", () => {
    expect(kinds(md("## Invariants", "",
      "- **Deferred scope:** Remove the orphaned Elixir library source in #2000; production rollout follows the complete stack.",
    ))).toEqual(["commitment:Deferred scope"]);
    expect(kinds(md("## Invariants", "", "### Deferred scope",
      "- No integration-read grant for Claude, no autoapproval of inventory, no permission expansion, and no deployment.",
    ))).toEqual(["invariant:Deferred scope"]);
  });

  it("reads decisions with bold labels (f67e119456 #1976), ignores open decisions, and treats a follow-up stack as later work", () => {
    expect(rows(md("## Decisions recorded",
      "- **Who can start one:** members of the internal Clerk organization named by `MATRIX_INTERNAL_CLERK_ORG_ID`.",
      "## Open decisions", "- Whether a Private Preview can be shared.", "## Follow-up stack",
      "1. Platform data model and guards.", "## Next steps", "- Ship the model adapter.", "## Residual risks", "",
      "Both remain after this change.", "", "- The sweep can lag one run behind."))).toEqual([
      ["decision", "Who can start one", "high", "members of the internal Clerk organization named by `MATRIX_INTERNAL_CLERK_ORG_ID`."],
      ["commitment", "Deferred scope", "medium", "Platform data model and guards."],
      ["commitment", null, "high", "Ship the model adapter."], ["risk", null, "high", "The sweep can lag one run behind."],
    ]);
    expect(rows(md("## Decisions", "", "One store per owner."))).toEqual([["decision", null, "high", "One store per owner."]]);
  });
});
