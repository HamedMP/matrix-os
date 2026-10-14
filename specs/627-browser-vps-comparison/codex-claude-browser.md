# Same Chrome tools for Codex and Claude Code Chat

Status: active. Owner requested both additional harnesses in the existing Browser app. This follow-up inherits the shared Chrome authentication and control rules in `shared-chat-security.md`; it introduces no public CDP endpoint, additional browser profile or platform credential.

## Implementation units

### U5 — Shared native MCP run lease
- Goal: admit Codex and Claude to the existing broker through a focused, ephemeral MCP lease helper.
- Files: shared-browser contract/broker harness enums, a new focused native browser MCP helper, existing shared-browser broker/MCP tests.
- Approach: personal, non-shared, default-interaction, full-access runs only. Exact owner/Chat/run/harness binding, fresh nonce and token per execution attempt. Fixed stdio server and loopback gateway port; no token in persisted session state. Shutdown/cancel revoke immediately; stale cleanup cannot revoke a successor. Existing Pi/Hermes/OpenClaw behavior remains qualified independently.
- Execution note: test first; reuse `shared-browser-cli` and broker lifecycle rather than duplicate actions.
- Test scenarios: allowed and excluded scopes, fresh nonce, abort, idempotent close, cleanup race, invalid gateway port, redacted logs, bounded wait and revoked tokens.
- Verification: contracts, broker/MCP tests and gateway typecheck.

### U6 — Claude Code adapter
- Goal: connect the Claude Chat CLI to the same Chrome and owner controls.
- Files: Claude provider adapter, focused launch helper, narrow launcher/composition wiring, existing Claude Chat and launcher tests.
- Approach: merge the dedicated MCP configuration with Matrix integration tools, preserving strict MCP configuration and disabled native local Chrome mode. Resolve dependencies during registration. Close the prior execution lease before recursive Steer reuses a canonical run ID; retain safe tool activity projection.
- Execution note: test first, including the actual composition and MCP launch arguments.
- Test scenarios: launch/resume/Steer, completion/failure/cancellation, old cleanup versus successor, permission/shared/review exclusion, same-browser action path and generic errors.
- Verification: focused integration tests and actual owner-authorized preview qualification when model login is ready.

### U7 — Codex app-server adapter
- Goal: renew same-Chrome authority on every turn even when the native app-server survives.
- Files: focused internal workspace/native browser context helper; narrow coding adapter, workspace-provider and launcher wiring; extract configuration/lifecycle helpers before adding behavior to oversized runner/thread-store modules. Existing Codex reliability, control, contract and Chat tests.
- Approach: spike pinned latest-verified CLI MCP refresh behavior without inference or owner credentials. Choose explicit supported MCP refresh or confirmed-stop/resume; do not replay a possibly accepted turn after a lost acknowledgement. Keep transient browser context internal to the gateway; public schemas cannot inject authority. Revoke owner browser control independently from native process acknowledgement.
- Execution note: undocumented native protocol spike first, then failing regressions and implementation.
- Test scenarios: first turn, resumed next turn, stale token, cancel/lost acknowledgement, uncertain accepted turn, refused refresh, no duplicate actions, no persisted token and excluded scopes.
- Verification: pinned CLI protocol proof, contract/reliability suites, actual same-Chrome simple-site run and owner takeover evidence when login is available.

## Review and documentation

One owner scopes implementation to a separate follow-up worktree/PR above the existing six-PR native GitHub stack. The six existing review gates remain distinct. Record exact live-tested versions and limitations; update the public documentation PR with available harnesses and simple prompts only after successful qualification. No real account pages, credentials or private incident details enter published evidence.

## Local verification (2026-10-14)

U5 and U6 have focused unit/adapter qualification only: 100 tests across seven files pass on Node 24.13.1; gateway build passes. These exercise fresh leases, exact-row cleanup, scoped admission, strict Claude MCP merging without bearer argv, preflight failures, completion, and delayed browser drain before Steer creates the next execution. Existing Claude, OpenClaw, Hermes and launcher suites remain green. Claude environment interpolation follows the official MCP documentation at https://code.claude.com/docs/en/mcp; exact pinned native startup/tool catalog remains a required preview probe. No model execution or account-browser workflow is claimed.

The public `scripts/spikes/browser-vps/codex-mcp-refresh.mjs` probe sends initialization, synthetic MCP thread start/resume, catalog reads and reload only. It never submits a model turn or requests authentication. Its caller must isolate the native owner's home and network. The actual pinned 0.162.1 probe confirms that a fresh native child is required to renew MCP environment authority while resuming the same persisted thread; see `codex-claude-native-verification.md`. Real model use and owner takeover remain separate preview qualifications.

## Trying the shared tool in Chat

Matrix Pi and OpenClaw advertise `shared_browser`; Hermes, Codex and Claude Code use the dedicated MCP name `mcp__matrix_shared_browser__shared_browser`. A skill must select the tool present in its current run catalog. The native Codex/Claude connection is limited to personal, non-shared, default-interaction, full-access runs; excluded runs do not receive browser authority. CLI installation alone does not enable the tool.

After the adapter is deployed and model access is ready, start with: “Use Matrix Browser to open example.com and tell me its page title.” The agent should first inspect shared-browser status and use the visible Chrome. Owner Take over pauses further browser actions; explicit Resume requires a fresh snapshot. Browser Use and agent-browser are optional automation engines behind the shared control boundary, rather than a requirement for each Chat harness.
