# Implementation plan: Jev recipes and use-jevs

Updated: 2026-09-21. [Product spec](spec.md), [design](design.zh-en.md). All tasks below remain implementation work; this PR changes documents only.

## 1. Confirm existing Gateway contract

- [ ] Locate Hamed's Jev API and record exact endpoint, evaluation schema, model mapping, scoped-runtime authentication, usage and billing semantics.
- [ ] Verify a real owner-scoped call, correct credit settlement and zero-credit/policy rejection. No personal TypeSafe key in setup.
- [ ] Confirm Gateway Jev eligibility is independent of the main model's provider selection. Record the minimal missing adapter/wiring if any; do not build another Gateway.

## 2. Shared decision tool

Likely touch points: existing integrations MCP registration, focused Gateway adapter/contracts, existing funded runtime credentials and accounting. Verify current paths before editing; extract rather than expanding oversized composition files.

- [ ] Write failing contract tests for text/question bounds, stable IDs, choice membership, confidence/abstention and invalid response handling.
- [ ] Write auth/accounting tests for cross-owner access, disabled policy, insufficient credit, duplicate dispatch, settlement replay and unknown timeout outcomes.
- [ ] Implement one jev_judge tool calling the verified existing API; no key/payer/endpoint/approval input fields.
- [ ] Reuse timeouts, bounded response handling, live policy, atomic accounting and idempotency; no automatic paid retries.
- [ ] Register dependencies at startup and expose truthful capability/readiness. Run focused checks and existing tool/funded-path regression tests.

## 3. Bundle use-jevs

- [ ] Use the repository's existing skill authoring/catalog/distribution paths; synchronize generated outputs through their source mechanism.
- [ ] Write the skill guidance from the design: selective calls, compact evidence, batching, stable labels, hand_back, authorization and truthful outcomes.
- [ ] Verify discoverability and actual shared-tool access from Matrix Hermes. Verify additional agents individually before naming them supported.
- [ ] Test missing skill/tool, denied Matrix AI, imported workflows and primary model on a personal account. No global hooks, provider switch or separate credential setup.

## 4. Build three initial recipes

- [ ] Email triage: bounded categories and message IDs; safe fixture dataset; recommendations only.
- [ ] Research shortlist: relevance judgments with stable source IDs; main-agent evidence verification.
- [ ] Task routing: choose available skill/tool candidates with hand_back; retain independent action permissions.
- [ ] Reuse existing recipe/skill references and add only necessary readiness/dependency semantics; no generic workflow engine.
- [ ] For each recipe record inputs, successful real call/output, ambiguous judgment and unavailable/zero-credit behavior. Preserve old recipe compatibility.

## 5. Minimal UI and runtime acceptance

- [ ] Reuse recipe/skill discovery, Matrix AI status/top-up and Chat activity. Add no Jev settings panel, source selector or key form.
- [ ] Verify optional fallback versus explicitly required-step blocking, truthful usage, owner/runtime switches and applicable OS presentation parity.
- [ ] Demonstrate a personal-main-model run with only Jev steps charged to Matrix AI; verify actual owner accounting.
- [ ] Measure success/latency/main-model and Jev usage on the fixed demos without assuming savings.
- [ ] Perform exact-head Human Review and required checks, documenting actual supported agent/runtime combinations.

## 6. Documentation and release

- [ ] Deliver a separate public documentation PR in the site repository covering recipes, use-jevs invocation, Matrix credit requirements, unchanged main-model provider and failure recovery.
- [ ] Gate availability on actual Jev endpoint/auth/accounting readiness; feature disable stops future dispatch non-destructively.
- [ ] Complete review/CI gates before any separately authorized rollout.

## Explicitly deferred

Personal Jev keys and source switching; Ultrafast/browser execution; native OS navigation; a generic MCP-dependency framework; universal coding-agent support. These do not block completion of the agreed first release.
