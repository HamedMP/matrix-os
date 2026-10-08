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

describe("rules decisions under design-note sub-headings", () => {
  it("keeps a sub-heading's item only when it states a choice (specs 057, 084, 033); own labels and prefixes stay", () => {
    expect(rows(md("## Key Design Decisions", "", "### Canvas Title Bars",
      "- Two styles: macOS glass pill (default) and Win98 raised bevel (neumorphic)",
      "- `isFocused` uses scalar `maxZ` selector to avoid O(n) work per window per store tick",
      "### Neumorphic Theme System", "- Neumorphic CSS rules use `[data-theme-style=\"neumorphic\"]` selectors in globals.css",
      "### Stripe Surface", "- Checkout: Stripe Checkout Sessions, `mode: \"subscription\"`.",
      "- API keys: prefer restricted API keys (`rk_`) per environment and per service where permissions allow it.",
      "- Do not pass `payment_method_types`; allow dynamic payment methods from Stripe Dashboard configuration.",
      "- Use Azure Artifact Signing with GitHub OIDC as the primary signer.",
      "- Folders-inside-packages chosen over package-per-domain.", "- The gateway will own the catalog.",
      "- Matrix MUST keep a platform-owned runtime catalog.", "- Plans never resize machines.",
      "- Matrix does not add an extra-runtime item instead of a new subscription.",
      "- A separate checkout rather than a second item.", "- Decision: one subscription per computer.",
      "### Source Of Truth", "- **Identity**: Clerk user ID.", "### Middleware unaffected",
      "The existing `proxy.ts` only protects `/dashboard` and `/admin` routes. `/docs` is public by default.",
      "### Explicit Decision: No Running Warm Pool in V1", "- Clones start cold.",
    ), "git_spec")).toEqual([
      ["decision", "Stripe Surface", "high",
        "API keys: prefer restricted API keys (`rk_`) per environment and per service where permissions allow it."],
      ["decision", "Stripe Surface", "high",
        "Do not pass `payment_method_types`; allow dynamic payment methods from Stripe Dashboard configuration."],
      ["decision", "Stripe Surface", "high", "Use Azure Artifact Signing with GitHub OIDC as the primary signer."],
      ["decision", "Stripe Surface", "high", "Folders-inside-packages chosen over package-per-domain."],
      ["decision", "Stripe Surface", "high", "The gateway will own the catalog."],
      ["decision", "Stripe Surface", "high", "Matrix MUST keep a platform-owned runtime catalog."],
      ["decision", "Stripe Surface", "high", "Plans never resize machines."],
      ["decision", "Stripe Surface", "high", "Matrix does not add an extra-runtime item instead of a new subscription."],
      ["decision", "Stripe Surface", "high", "A separate checkout rather than a second item."],
      ["decision", null, "high", "one subscription per computer."],
      ["decision", "Identity", "high", "Clerk user ID."],
      ["decision", "Explicit Decision: No Running Warm Pool in V1", "high", "Clones start cold."],
    ]);
  });

  it("keeps items placed directly under a Decisions heading, and checks nested sub-headings (specs 107, 093)", () => {
    expect(rows(md("## Decisions", "", "- Every project owns exactly one terminal workspace backed by one Zellij session.",
      "### Window Management", "#### Dock", "- Minimized windows render as animated dock icons.", "- We decided on one dock.",
      "## Risks", "### Storage", "- The disk can fill.",
    ), "git_spec")).toEqual([
      ["decision", null, "high", "Every project owns exactly one terminal workspace backed by one Zellij session."],
      ["decision", "Dock", "high", "We decided on one dock."], ["risk", "Storage", "high", "The disk can fill."],
    ]);
  });

  it("never reads open questions or decisions as claims, under any claim section or label", () => {
    expect(rows(md("## Decisions", "- One pool per owner.", "### Open questions",
      "- Should we use one pool per owner?", "#### Pools", "- Must pools be shared?", "### Storage",
      "- We decided on one store.", "## Invariants", "### Open decisions", "- Must the lock be per scope?",
      "## Deferred scope", "### Open questions", "- Whether invoices land later.", "## Risks",
      "- **Open questions:** whether the disk fills.", "- **Open question:**", "  - Must the sweep lag?",
      "- Decision: one sweep per scope.", "## Decisions", "**Open questions:**", "- Should we use one pool per owner?",
    ), "git_spec")).toEqual([
      ["decision", null, "high", "One pool per owner."], ["decision", "Storage", "high", "We decided on one store."],
      ["decision", null, "high", "one sweep per scope."],
    ]);
  });
});

describe("rules structure", () => {
  it("stops before the git footer and truncation marker, and skips fences, comments, checkboxes and trailers", () => {
    const message = md("## Invariants", "", "### Deferred scope", "", "Sharing a Private Preview.");
    const body = `${message}${GIT_TRUNCATION_MARKER}\n\n${FOOTER}`;
    expect(claimSourceText({ provenance: "git_pr", body })).toBe(message);
    expect(claimSourceText({ provenance: "git_spec", body })).toBe(body);
    expect(rows(body)).toEqual([["invariant", "Deferred scope", "high", "Sharing a Private Preview."]]);
    expect(rows(`${message}\n\n${FOOTER}`, "git_commit").map((row) => row[0])).toEqual(["invariant"]);
    expect(kinds(`${message}\n\n${FOOTER}`, "manual")).toContain("commitment:Deferred scope");
    // Code fences, HTML comments, checkboxes, trailers, trivial and process lines.
    expect(rows(md("## Summary", "", "```md", "## Invariants", "- **Source of truth:** fenced", "```", "",
      "## Invariants", "<!-- - **Source of truth:** template", "-->", "~~~", "- **Lock/transaction scope:** fenced", "~~~",
      "- [x] Source of truth: a validation checkbox", "- **Lock/transaction scope:** N/A",
      "- Greptile 5/5 on the exact head.", "- Real: the only claim.", "Co-authored-by: A <a@example.com>",
    ))).toEqual([["invariant", null, "medium", "Real: the only claim."]]);
  });

  it("reads bare headings and label lines; a separator ends a squash entry (e33656d400); literal escapes are text", () => {
    expect(rows(md("* chore(cli): bump", "", "Invariants", "", "Source of truth:", "The CLI package version.", "",
      "- Lock/transaction scope: no writes.", "", "---------", "", "* fix(cli): second", "", "Tests:",
      "- Source of truth: not an invariant."), "git_commit")).toEqual([
      ["invariant", "Source of truth", "high", "The CLI package version."],
      ["invariant", "Lock/transaction scope", "high", "no writes."],
    ]);
    expect(rows("## Invariants\\n- **Source of truth:** one line with literal escapes")).toEqual([]);
  });

  it("reads spec decisions and non-goals and kind prefixes anywhere; titles and in-scope headings open nothing", () => {
    expect(rows(md("# Spec 124", "", "**Decision:** Postgres is the only store for claims.", "", "## Non-goals", "",
      "- A claims UI (follow-up spec).", "- Organization scopes.", "", "## Summary", "", "- Risk: the sweep may lag.", "",
      "Follow-up: wire the kernel tool."), "git_spec")).toEqual([
      ["decision", null, "high", "Postgres is the only store for claims."],
      ["commitment", "Deferred scope", "medium", "A claims UI (follow-up spec)."],
      ["invariant", "Deferred scope", "high", "Organization scopes."], ["risk", null, "high", "the sweep may lag."],
      ["commitment", null, "high", "wire the kernel tool."],
    ]);
    // A title, in-scope or bare auth heading opens no section (specs 534, 067, 109, 008).
    expect(rows(md("# Safe approval details and recorded decisions", "## Problem and scope", "- Presentation only.",
      "## Goals / Non-Goals", "### Goals", "1. `matrix onboard` interactive flow.", "### Non-Goals",
      "- **Billing / paid tiers.** v1 is free only.", "## Scope and Decisions", "### In Scope",
      "- A sanitized golden snapshot.", "### Explicit Decision: No Running Warm Pool in V1", "- Clones start cold.",
      "## Part B: Multi-Tenant Hackathon Platform (NEW)", "### Authentication", "- Passwordless, phishing-resistant",
      "## Invariants", "### Authentication", "- Owner sessions only.", "### Scope", "- Ship it.", "## Deferred scope",
      "### Billing", "- Invoices land later."), "git_spec")).toEqual([
      ["invariant", "Deferred scope", "high", "**Billing / paid tiers.** v1 is free only."],
      ["decision", "Explicit Decision: No Running Warm Pool in V1", "high", "Clones start cold."],
      ["invariant", "Auth source of truth", "high", "Owner sessions only."],
      ["commitment", "Deferred scope", "medium", "Invoices land later."],
    ]);
  });

  it("bounds claims per document and statement length; spans stay exact", () => {
    const many = md("## Invariants", ...Array.from({ length: 210 }, (_, n) => `- Bullet number ${n} holds.`));
    const capped = run(many);
    expect(capped.claims).toHaveLength(50);
    expect(capped.claimsRejected).toBe(160);
    // Unlabelled paragraphs wait for the section's end; at most 200 are held.
    const held = run(md("## Decisions", ...Array.from({ length: 201 }, (_, n) => `\nParagraph ${n} holds.`)));
    expect([held.claims.length, held.claimsRejected]).toEqual([50, 150]);
    expect(run(many, "git_pr", 3).claims.map((claim) => claim.statement)).toEqual(
      ["Bullet number 0 holds.", "Bullet number 1 holds.", "Bullet number 2 holds."]);
    const long = run(md("## Invariants", `- ${"word ".repeat(300)}\ud83e\udd16`)).claims[0]!;
    expect(long.statement.length).toBeLessThanOrEqual(1_000);
    expect(long.quote).toBe(`${"word ".repeat(300)}\ud83e\udd16`);
    expect(run("").claims).toEqual([]);
  });

  it("labels from sub-headings and label lines, ignores prose headings, reads CRLF, keeps surrogate pairs whole", () => {
    const pair = `${"a".repeat(999)}\ud83e\udd16${"b".repeat(998)}\ud83e\udd16c`;
    const body = md("## Invariants", "### Process table", "- One owner.", "### Non-goals", "- No UI.",
      `### ${"x".repeat(201)}`, "- **One two three four five six seven:** words.", "**Notes:**", "- A note.",
      "**Notes:** Stack:", "- Ignored.", "Invariants", "Validation:", "- Ignored too.", `## ${"Invariants ".repeat(20)}`,
      "- Ignored prose.", "## Invariants\r", `- ${pair}\r`, `- ${"z".repeat(1_001)}`);
    expect(rows(body)).toEqual([
      ["invariant", "Process table", "medium", "One owner."], ["invariant", "Deferred scope", "high", "No UI."],
      ["invariant", null, "medium", "**One two three four five six seven:** words."],
      ["invariant", "Notes", "medium", "A note."], ["invariant", null, "medium", "a".repeat(999)],
      ["invariant", null, "medium", "z".repeat(1_000)],
    ]);
    expect(run(body).claims.map((claim) => claim.quote.length).slice(-2)).toEqual([1_999, 1_001]);
  });
});
