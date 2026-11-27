# Reduce Matrix Chat input token overhead

[ENG-567](https://linear.app/matrix-os/issue/ENG-567/reduce-matrix-chat-input-token-overhead)

Codex and Claude Chat should spend less input context on unrelated App and Browser guidance. A short orientation still identifies the Matrix skills, data model, and tool boundaries. App requests can consult the existing App Builder skill for detailed requirements and validation. Native tool discovery should prefer Matrix Core MCP and use the read-only integration CLI only as an authorized fallback.

## Behavior requirements

- Preserve the kernel's orientation and the native Chat permissions, data ownership, trust boundaries, and scoped tool registration.
- Keep the Browser tool discoverable in eligible runs. Put procedural details in its shared tool description so both providers receive the same guidance when using it.
- Preserve approvals, denial, cancellation, and streaming. Keep the Claude stdio approval bridge until a lower-overhead transport passes those behaviors on the supported CLI. The current SDK callback uses the same bridge.
- Claude native schedule recovery accepts the frozen previous prompt only when the full source fingerprint matches. The same protected child can continue without rekeying its receipt. Changes to credentials, workspace, model, permissions, or tool scope still fail the existing fence.
- Keep prompt, file, and account content out of benchmark telemetry.

## Validation

Compare native provider and full Chat input on the same Dev computer with a fixed model, effort, tier, and matched synthetic prompts. Record the exact installed and running commit, per-turn gross and cached input, and completion status. Exercise App Builder skill discovery, a multi-turn Chat, and representative tool and approval flows. Track any workflow coverage gaps alongside test results.

## Public documentation

Submit a separate [documentation PR in FinnaAI/matrix-os-site](https://github.com/FinnaAI/matrix-os-site) under `content/docs/`. Explain how native Chat uses App Builder guidance on demand and how connected tools remain scoped to the run. Link both PRs to ENG-567.

## Follow-up benchmark

[ENG-578](https://linear.app/matrix-os/issue/ENG-578/reduce-remaining-matrix-chat-input-overhead)

Use a single owner-only Private Preview tied to the follow-up PR. Publish its baseline and candidate bundles with the Preview VPS workflow in bundle-only mode. Verify the source PR, owner, installed and running commit, release version, and managed CLI version before each run. Keep Main and Dev outside the experiment. Use supported owner authentication and synthetic test data.

For each provider, compare the native CLI and full Matrix Chat on the baseline, then repeat on the candidate. Match the prompts, model, effort, workspace, provider account, and native permission policy. For the plain-chat case, use two questions in one fresh thread: "What is 17 times 19? Reply with only the number." and "Why does the daytime sky look blue? Answer in two sentences." Repeat each pair and report per-turn gross input, cached reads and writes where available, latency, answer correctness, and whether tools ran. Report overhead against native CLI and savings against baseline Matrix Chat. Capture only sanitized usage and workflow receipts.

The first candidate can remove repeated tool guidance and make detailed read-only CLI examples available on demand. Keep existing tool discovery, schema, account selection, and authorization behavior. Verify App Builder, implicit and later-turn tool discovery, integration reads and approval or denial, Company Drive scope, Browser takeover, and long-session continuation. Record any unavailable live workflow alongside the results.

Evaluate a lower-input Claude approval transport independently. The current bridge remains active until an alternative demonstrates lower input and preserves request identity, approvals, denials, questions, cancellation, partial streaming, scheduling, and protected recovery on supported CLI versions. Evaluate corrections to history replay only after measuring normal resume, compaction and fresh recovery separately.

## Follow-up launch contract

- Codex keeps the Core MCP inventory and action paths discoverable. The installed Matrix Integrations skill documents the read-only fallback with exact account and filters. The `matrix_routines` name, eager registration, arguments, and owner decision flow stay intact.
- Claude Chat uses compact launch guidance and the existing stdio approval bridge. Protected continuation and idle recovery may use either prior gateway-owned guidance only after the full saved source fingerprint matches an exact reconstruction. Existing eligibility, Browser wiring, and tool authority still apply.
- Compare the candidate's gross input against baseline Matrix Chat for savings and against a matched native CLI control for remaining overhead. Codex's acceptance threshold is below 3%. Record Claude's measured outcome and functional checks. Live Browser testing is outside the scope of this Private Preview run.
