# Built-in Jev: Gateway + Personal API implementation plan

Updated: 2026-09-21. Governing behavior: [spec.md](spec.md); interfaces: [design.zh-en.md](design.zh-en.md). This is a documentation plan, not runtime acceptance or deployment authorization.

## Delivery and constraints

Support both sources through one capability, MCP tool and recipe. Gateway debits Matrix AI balance; Personal API bills the user's TypeSafe account. Explicit source selection, immutable run binding, live authorization and no automatic cross-source fallback are required throughout. Preserve existing BYOK selection on upgrade. Basic judgments require no browser.

Follow TDD and focused modules; PostgreSQL/Kysely only. Use the existing funded ledger and scoped runtime credential path, encrypted custom-MCP boundary and shared presentation components. Recheck source drift before implementation; last inspected main was e62d3fc62. Keep the original dirty checkout untouched.

## 1. Verify Gateway evaluation contract

- [ ] Locate actual Hamed Jev integration/endpoint; document deployed vs source-only state. Do not infer support from the general Gateway UI or chat model list.
- [ ] Spike the evaluation schema, approved model/version, usage mapping and pricing using controlled test credentials. Never print secrets.
- [ ] Demonstrate ordinary owner-runtime authorization, sufficient-credit success, zero-credit/policy rejection, atomic settlement and accounting retry without duplicate inference.
- [ ] Record exact unsupported/missing gates. Gateway remains explicitly unavailable until proven; Personal API can be independently validated without claiming the dual-source release complete.

## 2. Contracts and storage

Target contracts: packages/contracts/src/jev.ts, chat-agent-recipe.ts, chat-agent-context.ts; custom-MCP types/repository. Extract focused persistence before adding behavior to large platform-db composition files.

- [ ] Failing tests first: strict question/result bounds, gateway/personal_api/null source, safe per-source status, absent recipe dependencies, backend remote/builtin union.
- [ ] Add owner singleton configuration, selected source, revision, optional personal credential reference, live policy, immutable run-source binding and source-tagged receipts.
- [ ] Implement transactional revision checks, idempotent create, outbox projection, credential generation fencing and bounded cleanup.
- [ ] Migrate existing personal-key configurations to personal_api; preserve remote URL/OAuth semantics and old recipes.
- [ ] Verify recipe copy/export drops source settings, private bindings and billing authority.

## 3. Common broker and two adapters

Target packages/gateway/src/integrations/jev/ and existing custom-MCP broker; funded credential manager; packages/proxy funded relay and packages/platform funded repositories as Gateway contract requires.

- [ ] Red tests for direct TypeSafe mapping, fixed endpoint/Bearer, malformed/oversized responses, timeouts, 401/429, no hidden retry and no Matrix AI debit.
- [ ] Red tests for Gateway evaluation mapping, allowlist/pricing, owner/runtime token, insufficient balance, reservation denial and correct settlement.
- [ ] Normalize both adapters to one result contract; never allow model arguments to choose payer/source/endpoint/key.
- [ ] Use existing funded accounting with idempotent settlement; unknown outcomes reconcile under original payer. No parallel ledger or cross-source retry.
- [ ] Verify duplicate receipt, crash-before-dispatch, lost response and settings switch never cause a second call/debit.
- [ ] Verify owner B cannot discover/use/test/update owner A authority; disable blocks new dispatch; personal-key removal leaves Gateway intact.

## 4. Run admission, recipe and guidance

Target chat/agent-recipe.ts, agent-context.ts, run context contracts and existing matrix-integrations MCP discovery/call registration.

- [ ] Resolve selected source at admission, pin it for the run and recheck live authorization before dispatch. Permit same-source credential renewal only.
- [ ] Test source change during queued/active runs, expired runtime token, revoked key, changed entitlement and untrusted source fields.
- [ ] Keep portable mcpDependencies source-neutral; optional unavailable continues with primary model, required blocks/pauses dependent work.
- [ ] Ship selective-use skill and synchronized generated catalog; no forced per-turn call and no automatic action approval.
- [ ] Test old recipes, actual discovery/call wiring and disabled capability projections.

## 5. Shared frontend

Targets packages/ui/src/jev/, AgentRecipeEditor/McpTools, Web CustomMcpServersPanel and Electron McpServersSection.

- [ ] Red tests for source selector, source-specific readiness, balance recovery, personal-key lifecycle, explicit billable test and metadata-only readiness.
- [ ] Add shared state/client/components; Gateway never requires TypeSafe key. Show charge source on tool activity; only authoritative settled amounts appear as charges.
- [ ] Preserve both configurations across source changes; explain new-run scope and require stop/new run for an active-source change.
- [ ] Protect unsaved recipe edits; clear secret form memory; reject late responses after account/runtime switches.
- [ ] Verify Web Desktop/Web Canvas/Electron Desktop parity and applicable mobile surfaces, including unavailable/disabled/error states and old-runtime compatibility.

## 6. Real runtime acceptance and documentation

- [ ] Exercise actual Matrix Hermes Chat with both sources; Gateway test account has no personal TypeSafe key.
- [ ] Verify source-specific failure matrix, owner isolation, copied recipe, no cross-source fallback and correct charging evidence.
- [ ] Compare fixed task sets and report main-model/Jev usage, success and end-to-end latency without preclaimed savings.
- [ ] Complete exact-head Human Review and relevant tests/checks before rollout; mocks do not establish live support.
- [ ] Deliver separate public-site documentation PR covering two setup paths, charging, tests, source switching, limits and repair. Additional harnesses require their own real verification.

## 7. Conditional Ultrafast delivery

- [ ] Spike pinned upstream Python/Chrome/Browser Harness in target runtime; record license, packaging, upgrade owner, browser profile isolation and cleanup.
- [ ] Prove separate authenticated local bridge before claiming VPS-to-local Chrome support.
- [ ] Replace upstream text helper with primary-Agent text and route both Jev sources through common broker without worker secrets.
- [ ] Red tests: source-pinned browser sessions, one-use/stale proposals, permissions, uncertain mutation, sensitive-state redaction, TTL/cancel/shutdown and network destination policy.
- [ ] Implement start/next/execute/close with separate browser authorization/readiness; independently verify results and close owned tabs only.
- [ ] Demo real Hermes navigation/search/filter with each source; measure and document limitations. Enable only after exact-head acceptance.

## 8. Independent Matrix navigation follow-up

- [ ] Specify owner/runtime/client targeting, fresh observations, bounded actions and actual renderer acknowledgement.
- [ ] Implement through shared contracts and existing renderer launch/focus/settings helpers; prevent cross-device broadcasts and stale/replayed actions.
- [ ] Validate no-client/multiple-client/error cases and real navigation across applicable OS views. Jev source follows the same run binding.

## Completion evidence

All checkboxes above are planned work. No product implementation, inference tests or deployment were performed by updating this specification.
