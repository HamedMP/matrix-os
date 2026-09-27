# Specification Quality Checklist: Machine-Free Collaborative Work

**Purpose:** Validate completeness before technical planning.
**Created:** 2026-09-26
**Feature:** [spec.md](../spec.md)

## Content quality

- [x] Product spec focuses on user value and observable behavior; architecture constraints are in a separate companion.
- [x] Mandatory user scenarios, requirements, entities and success criteria are complete.
- [x] New proposals are distinguished from implemented or production-verified behavior.
- [x] Existing 121/124/525 policy and UX decisions are explicitly reconciled.

## Requirement completeness

- [x] No unresolved clarification placeholders remain; reasonable defaults and exclusions are explicit.
- [x] Free account creation, machine-free entry, auth return and empty states are covered.
- [x] Existing organization members and external guests have distinct authorization journeys.
- [x] Email-before-signup, recipient binding, forwarded invitations and duplicate acceptance are covered.
- [x] Roles, AI opt-in, owner funding, limits and broader tool boundaries are explicit.
- [x] Presence, mentions, private drafts, co-editing, comments, history and proposals have acceptance scenarios.
- [x] Revocation, account deletion/switching, host outage and unsaved-work recovery are covered.
- [x] Requirements and success criteria are identified, measurable and testable.
- [x] Every route family has an auth boundary; concrete endpoint enumeration remains a technical-plan obligation.
- [x] Ownership, atomicity, policy leases, capacity and shutdown/cleanup constraints are recorded.

## Feature readiness

- [x] All six user stories map to staged usable milestones and live acceptance evidence.
- [x] All five named user surfaces have explicit gates, including Native Mobile repair and device evidence.
- [x] Separate public site documentation PRs are implementation deliverables.
- [x] No tests, screenshots, implementation or production readiness are claimed without execution.

## Review notes

The first review clarified that spec 124 already promises no recipient computer, so M1 repairs/proves the entry flow instead of inventing new hosting. The guest relationship extends both ticket issuance and home authority without weakening existing org-member checks. External guest AI requires constrained tools; existing member integration authority is not an implicit guest grant. Online co-editing preserves unsaved local work without claiming independent offline authorities. The concrete editor protocol, route paths, retention values and source-specific limit adapters are intentionally technical-planning decisions with required proof gates, not unresolved product choices.

The second review added organization membership independent of machine count in both directions (FR-024), recipient views for every shareable type (FR-025), file-share conflict detection (FR-026), unavailable-versus-not-found distinction (FR-027), relay bounds for machine-free accounts (FR-028) and an unattended cross-account fixture (FR-029, SC-009). It recorded baseline blockers with file references and current limits in `architecture.md`, added an M0 foundation-validation milestone, and mapped the organization-collaboration live-validation journeys (PR #1892) to this specification in `delivery-plan.md`.

## Validation executed for this spec PR

- Requirement numbering: 29 unique sequential FR IDs and nine unique sequential SC IDs; passed.
- Relative Markdown links, balanced fenced blocks and absent clarification placeholders; passed. The repository-global feature pointer is unchanged by this PR; use the explicit feature directory for downstream planning.
- Static public-site-boundary assertions from `tests/repository/site-extraction.test.ts`, evaluated directly without Vitest; passed.
- The canonical Vitest docs-contract invocation could not run because this isolated checkout has no installed `vitest` executable. This is not a passing test-suite claim; CI must run it with the frozen dependencies.
- Product/authority review completed against the baseline identified in `architecture.md`; no runtime code was changed.

## Inline review decisions (2026-09-27)

- [x] Recruiting is removed from M1/M2 release gates; timed SC-002/SC-009 journeys gate them, SC-001 runs post-M2 and at final M5 acceptance.
- [x] Keep 300-second identity sessions with separate home-enforced authorization leases of at most 60 seconds, including outbound delivery and idle-subscription expiry.
- [x] Name Settings → Organization → External sharing as the M2 owner/admin policy surface, built on M1 organization controls with an account-only route.
- [x] Qualify a CRDT candidate through the actual relay, socket-cap and compaction workloads, lockfile/bundle effects and Native Mobile dev-client evidence.
- [x] Preserve all additions in `be39b4466`; explicitly qualify shared-drive guest transfers and remove the competing active-spec pointer change.

These are specification decisions and proof requirements, not claims that the editor, guest transfer path or policy-lease implementation already exists. Existing CI passed on `be39b4466`; updated-head checks must run separately.
