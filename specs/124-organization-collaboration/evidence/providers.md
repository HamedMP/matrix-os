# Provider boundary evidence (S00 / T002)

Harness: `tests/integration/collaboration-provider-boundaries.integration.ts`, run with
`bun run test:integration -- tests/integration/collaboration-provider-boundaries.integration.ts`.
Each live probe is gated on one fixture environment variable and reports `unrun: fixture <name> missing`
when absent. Tokens are read from the environment only and never written anywhere.

## Pinned versions at baseline `3b4662d28`

| Component | Version / pin | Source |
| --- | --- | --- |
| Claude Agent SDK | `0.3.240` | `packages/kernel/package.json` |
| Claude harness inside the scope runtime | `2.1.240` | `packages/scope-runtime/src/worker.ts:10` |
| Codex CLI inside the scope runtime | `0.154.0` | `packages/scope-runtime/src/worker.ts:11` |
| Scope-runtime profile | `scope-runtime-chat-v1` version 2 | `packages/scope-runtime/src/profile.ts:7-8` |
| Codex invocation | `codex exec --json --sandbox read-only` from `/workspace` | `packages/scope-runtime/src/worker.ts:290-357` |
| Claude credential env in the broker | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` | `packages/gateway/src/collaboration/scope-runtime-broker.ts:272-277` |
| Codex subscription auth file | `<home>/.codex/auth.json`, refresh at `auth.openai.com` | `packages/gateway/src/collaboration/codex-owner-identity.ts:11,160` |

## Probe ledger (last run 2026-09-20 on the development machine, no live fixtures)

| Probe | Fixture | Outcome |
| --- | --- | --- |
| Pinned harness and SDK versions recorded | none | pass |
| Codex invocation characterized as sandboxed exec with JSON output | none | pass |
| Claude API run writes only inside the selected worktree root | `COLLABORATION_PROBE_ANTHROPIC_API_KEY` | unrun: fixture missing |
| Claude API tool-approval callback can deny a tool and the run terminates | `COLLABORATION_PROBE_ANTHROPIC_API_KEY` | unrun: fixture missing |
| Claude API run stops promptly on cancellation | `COLLABORATION_PROBE_ANTHROPIC_API_KEY` | unrun: fixture missing |
| Claude session resume with a changed root (evidence for S09 fresh-continuation rule) | `COLLABORATION_PROBE_ANTHROPIC_API_KEY` | unrun: fixture missing |
| Codex API run writes only inside the selected worktree root | `COLLABORATION_PROBE_OPENAI_API_KEY` + `codex` binary | unrun: fixture missing |
| Codex native subscription auth used from another `CODEX_HOME` completes an authenticated turn (delegated request) | `COLLABORATION_PROBE_CODEX_AUTH_JSON` + `codex` binary | unrun: fixture missing |
| Claude subscription OAuth token used by a non-owner process completes an authenticated turn (delegated request) | `COLLABORATION_PROBE_CLAUDE_OAUTH_TOKEN` | unrun: fixture missing |

## Probe semantics and residual risk

- A delegated-request probe passes only on an authenticated successful turn: Codex must exit 0 with a `turn.completed`/`agent_message` JSON event and no auth rejection on stderr; Claude must yield a `result` message with `subtype: "success"`. A provider rejection or a thrown authentication error is a FAILED probe and is recorded here as `failed`, never as a pass.
- Codex reads credentials only from `$CODEX_HOME/auth.json`; there is no in-memory handoff. The probe never writes the credential to disk: the copy lives in RAM-backed tmpfs (`/dev/shm`) in a fresh `0o700` directory as a `0o600` file created with `wx`, for the duration of one `codex exec`; it is removed in `finally` right after the run and again in `afterEach`, `afterAll` and on process `exit`/`SIGINT`/`SIGTERM`. Every harness start sweeps stale `codex-cred-*` directories left by a `SIGKILL`ed run, and tmpfs contents vanish on reboot. If `/dev/shm` is not a writable tmpfs the probe fails rather than falling back to disk. Residual risk: between a `SIGKILL` and the next harness start or reboot, the copy is readable by root and by the probe's own user in RAM; run the probe only on a disposable machine with a disposable test credential, never with an owner's real `auth.json`.
- Clerk probes record the fixture's original role or membership before any mutation, restore it in `finally` with up to five verified attempts, and replay any still-pending restoration in `afterAll`; a restore that still fails throws with the manual repair instruction.
## Auth modes and their status

| Mode | Owner-only request | Delegated (member) request | Status |
| --- | --- | --- | --- |
| Claude API key (owner profile or Matrix AI funded lease) | supported by current broker | technically identical to owner-only; product decision R4 allows it | needs live probe before "supported" |
| Claude subscription OAuth | current broker passes `ANTHROPIC_AUTH_TOKEN` | provider terms are the owner's responsibility (R4) | unrun |
| Codex API key | `codex exec` with `OPENAI_API_KEY` | same | unrun |
| Codex ChatGPT subscription | host broker with `auth.json` refresh (#1761) | same; terms are the owner's responsibility (R4) | unrun |

No capability flag may be set to `true` on the strength of this file. A required mode that fails its live probe blocks release acceptance (sol-runbook.md, Gate handling).
