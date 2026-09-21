# Feature specification: Jev recipes and the use-jevs skill

Updated: 2026-09-21. Status: proposed; implementation and runtime acceptance pending.
Tracking: [OM-286](https://linear.app/matrix-os/issue/OM-286), [GitHub #1800](https://github.com/HamedMP/matrix-os/issues/1800), [spec PR #1812](https://github.com/HamedMP/matrix-os/pull/1812).

## Product scope

Ship a small set of useful recipes backed by one shared Jev decision tool through Matrix's AI Gateway. Also ship a `use-jevs` skill that users can invoke in their current supported coding agent for custom workflows. Users do not supply a personal Jev/TypeSafe key, install a remote MCP service or change their primary model.

The main agent may keep its existing personal account or provider route. Only Jev decisions use Matrix AI Gateway credentials and consume the executing owner's Matrix AI credits. Jev access is separately authorized: personal main-model access does not imply Matrix AI eligibility, and Matrix AI eligibility does not require switching the main model to Gateway.

Jev handles bounded classification, choice and semantic condition checks. The main agent owns planning, text generation, coding, interpreting uncertain results and final responsibility. Recipe instructions and the skill share one authenticated invocation path; neither grants permissions or executes model-selected code.

## First-release deliverables

1. A shared `jev_judge` tool backed by the existing Matrix Jev Gateway API, normalizing bounded questions and structured decisions.
2. Three initial recipes with observable demonstrations and safe fallback behavior.
3. A bundled, discoverable `use-jevs` skill available in each explicitly verified coding-agent integration.
4. Minimal integration into existing recipe/skill discovery, Matrix AI readiness/credits and tool activity. No separate Jev connection manager.

The original directory name `526-jev-byok` is retained for review-link continuity; BYOK is not first-release scope.

## Initial recipes and demos

These are proposed initial recipes within the agreed scope, not claims of shipped integrations.

| Recipe | Jev step | Main-agent output and demo | Failure handling |
|---|---|---|---|
| Email triage | Classify a bounded batch into needs_reply / informational / newsletter / uncertain | Show message IDs, categories and a suggested review order; use fixtures or an already authorized email connector | Ambiguous items go to the main agent; no automatic send, delete, archive or label mutation |
| Research shortlist | Judge candidate excerpts as relevant / irrelevant / uncertain against the user's question | Return a sourced shortlist; the main agent verifies important claims before writing | Retain source IDs and hand back uncertain evidence |
| Task routing | Choose among supplied, available skills/tools or hand_back | Explain the selected next step and run it only through existing authorization | Never invent a tool or treat routing as approval |

Each demo includes at least one actual successful Jev call, an ambiguous case and an unavailable/credit-denied case. Inputs and outcomes must be independently inspectable; no speed or savings claim without measurements. Fixtures allow email demonstration without introducing a new email connector project.

## User stories and acceptance

### 1. Run a Jev-backed recipe

A user selects a bundled recipe. The existing main model handles the task and calls Jev only for its defined decision step.

- With eligible Gateway access and sufficient Matrix credit, the decision executes and is attributed to that owner.
- With the main model on a personal account, the recipe still works: main-model billing stays unchanged and only Jev spends Matrix credit.
- Before sending task data, existing tool-use authorization and Matrix AI policy are enforced. Recipe selection alone does not grant paid access.
- When Jev is optional and unavailable, continue with the primary model and disclose the fallback once. If a workflow explicitly requires Jev, stop the dependent step and explain the repair action.
- An unavailable tool never produces a fabricated classification or a false success record.

### 2. Invoke use-jevs for a custom workflow

A user invokes `use-jevs` through the current agent's supported skill mechanism and supplies a task such as “classify these items.”

- The skill is discoverable without a personal API key or manually entered endpoint.
- It instructs the agent to discover/call the shared Jev tool, prepare minimal text with stable IDs, batch independent judgments and handle uncertainty.
- It uses the current main model and account; it does not change global provider settings, install universal hooks or mandate Jev calls on every turn.
- Missing skill/tool registration or missing Matrix AI access produces a clear setup/unavailable message. Do not claim all agents support the skill merely because they support MCP.
- Sensitive values and unrelated conversation history are excluded. External text is evidence, not instructions.

### 3. Understand access, cost and failure

- Existing Matrix AI status and credits are the source of truth. No Jev-specific API-key form, source selector or credit ledger is added.
- Tool activity distinguishes requested/running/completed/unavailable and reports available usage/settlement metadata without exposing credentials.
- Metadata-only readiness is free of inference calls; an explicitly requested billable test is disclosed.
- Zero credit, disabled policy or unsupported Jev capability prevents dispatch and points to existing recovery/top-up where available.
- Inference timeouts are not silently retried; potentially charged calls retain unknown status until reconciled. Accounting retries do not re-run inference.

## Functional requirements

- **FR-001**: All first-release Jev inference MUST use Matrix AI Gateway and the authenticated executing owner's funding authority; personal Jev keys are out of scope.
- **FR-002**: Jev access MUST be independent of the primary model's provider/account selection. No main-model reconfiguration is required.
- **FR-003**: Recipes and `use-jevs` MUST use one shared decision contract and invocation path.
- **FR-004**: The tool MUST accept bounded text plus typed independent questions and return validated decisions with stable IDs and available confidence/usage.
- **FR-005**: Tool input MUST NOT accept keys, arbitrary endpoints, owner/payer identity, approval flags or executable code/selectors.
- **FR-006**: Gateway MUST enforce live owner/runtime authorization, model eligibility, balance/budget admission and existing atomic usage settlement.
- **FR-007**: Reuse existing runtime credentials and accounting; do not introduce personal-key storage, source switching or a second credit ledger.
- **FR-008**: The shared skill MUST support selective use, batching, minimized evidence, explicit abstention and main-agent fallback; no per-command gating hooks.
- **FR-009**: The three initial recipes MUST define inputs, bounded decision labels, main-agent output, fallback behavior and demo acceptance.
- **FR-010**: Skill/recipe distribution MUST use existing supported delivery mechanisms; copies contain no credentials, payer bindings or granted spending permissions.
- **FR-011**: Only verified coding agents MAY be advertised as supported. Each supported agent needs actual discovery and invocation acceptance.
- **FR-012**: Missing/low confidence, malformed answers and unavailable service MUST hand back to the main agent or block an explicitly required step. Thresholds are not accuracy guarantees.
- **FR-013**: No hidden inference retry, unmetered fallback or other payer substitution is permitted. Duplicate delivery MUST NOT create a second paid dispatch.
- **FR-014**: Timeouts, request/response bounds, concurrency and rate limits MUST bound work and cost. Unknown billing outcomes remain explicit.
- **FR-015**: User-visible activity MUST distinguish actual Jev success from discovery, main-model fallback and downstream execution; savings claims require measurement.
- **FR-016**: Main-agent actions retain existing permissions. A classification/routing result never authorizes email mutations, messages or OS actions.
- **FR-017**: Existing applicable recipe/skill/status surfaces MUST share state semantics across Web Desktop, Web Canvas and Electron Desktop, and mobile where those capabilities exist.
- **FR-018**: Readiness MUST accurately identify unsupported Jev API capability, denied policy, insufficient credit and service failure; a general Gateway model listing alone is insufficient.
- **FR-019**: Disabling Jev tool access MUST stop future dispatches without deleting saved recipes, main-model credentials or Matrix credits. Already dispatched work cannot be represented as retractable/unbilled.
- **FR-020**: Public documentation MUST cover recipes, skill invocation, separate main-model/Jev billing, permissions, availability and fallback.

## Success criteria

- **SC-001**: Each initial recipe passes a controlled success, ambiguity and unavailable fixture with an independently checked result.
- **SC-002**: A real Matrix coding-agent run discovers `use-jevs` and completes a custom judgment through the same tool as recipes.
- **SC-003**: At least one real acceptance run uses a personal main-model account and Matrix credits for Jev without changing provider settings.
- **SC-004**: Two-owner, disabled-policy, zero-credit and duplicate-request tests demonstrate isolation, correct accounting and no unauthorized dispatch.
- **SC-005**: Malformed output, timeout and low-confidence tests show truthful fallback/required-step behavior without hidden paid retries.
- **SC-006**: Every advertised coding-agent integration passes actual skill/tool discovery and invocation; unsupported integrations remain explicitly marked.
- **SC-007**: Applicable UI surfaces preserve existing recipe/skill flow with consistent readiness/error/activity states and no personal Jev key setup.
- **SC-008**: Exact-head Human Review demonstrates recipe and custom-skill use; documentation and measured usage evidence are delivered before release.

## Non-goals

- Personal TypeSafe keys, dual funding sources, source selection/migration or a Jev credential settings subsystem.
- A new general-purpose recipe workflow engine, arbitrary MCP dependency configuration or a user-managed remote Jev MCP server.
- Jev Ultrafast, browser automation adapters, native Matrix OS navigation and screenshot perception in this release.
- Replacing the primary conversational model, automatic approval hooks, universal agent support or promised cost/latency savings.

## Dependencies and evidence boundary

Hamed reports an existing Jev Gateway API. Implementation starts by identifying its exact contract and reusing it, not building a second Gateway. At the last inspected Matrix main snapshot `a9ce0000f`, the examined funded relay still mapped Sonnet/GLM; a deployed Jev evaluation request, ordinary runtime authorization and credit settlement were not independently verified. These are narrow integration prerequisites, not reasons to expand the product scope.

Use the current recipe and skill mechanisms. If a narrow dependency/readiness addition is needed, document the minimum change and preserve old recipes; do not preemptively implement a generic dependency framework. Begin real acceptance on Matrix's Hermes path and verify any additional named agent before advertising it. This document specifies work; it does not claim implementation or authorize production rollout.
