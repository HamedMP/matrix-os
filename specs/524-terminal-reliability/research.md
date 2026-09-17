# Research and decisions

## Confirmed startup cause

Decision: use bounded adjacent input batching, retaining admission and authority checks.
Rationale: real Electron startup produced 259 color/capability replies; baseline live replay stayed connected at 32 individual replies, closed at 33, and stayed connected when the same bytes were coalesced. Both gateway and runtime pre-attach paths imposed a raw pending-frame limit. New unit and real Unix socket regressions failed before the repair and pass after it.
Alternatives: hiding the banner changes perception without preserving the connection; removing limits loses backpressure protection; increasing only the gateway limit leaves the runtime boundary vulnerable; discarding protocol replies changes terminal behavior.
Status: fix candidate in PR #1736, commit d4f20f8. Exact-head Preview/live validation remains required. Independent replay/snapshot and historical runtime failures remain unproven as causes of this incident.

## Superseded and retained specifications

| Source | Retained | Superseded detail |
|---|---|---|
| 098-terminal-session-reliability | Truthful status, durable process continuity, owner-safe diagnostics | Scalar `/api/terminal/sessions` contract; current legacy routes return 426 |
| 104-terminal-refactor-foundation | Testable separation, menu/install compatibility | Not an end-to-end connection specification |
| 107-terminal-multi-device | Workspace/tab references, per-workspace runtime, snapshots/replay | All-viewers-write rule conflicts with current single graphical writer |
| 119-terminal-session-lifecycle | No resurrection, explicit deletion/recovery, view close is detach | Old shell-sessions.json and per-session descriptor/recovery model |
| 127-provider-auth-terminal | Visible setup terminal, bounded wait, runtime selection fencing | No new provider authentication flow needed for reliability testing |
| docs/dev/terminal-session-ownership.md | Current ownership, upgrade and startup contracts | Early PR summaries are not current source of truth |

## Dimensions and readability

Decision: preserve current minimum readable text size and explicit panning where canonical width cannot fit.
Rationale: `terminal-grid-presentation.ts:140-181` and `terminal-soft-grid.ts:31-64` implement that tradeoff. The defect criterion is automatic sideways movement or inaccessible content, not the existence of all horizontal scrolling.
Alternative: always shrink to width would change readable-font behavior and requires separate user approval.

## Validation truth

On macOS, the repair's full suite returned 15,726 passing, 30 failing and 44 skipped tests. All 30 failing test names reproduce on the untouched de815be50 baseline. The 13 new regression tests, repository/runtime type checks, pattern scan and Electron production build passed. These results neither prove all platforms nor replace Human Review.

## Preview identity

The standard shared Preview owner differs from the reviewing account. Actual Electron selection of pr-1736 produced 404 on terminal routes. Preserve owner-only terminal authorization; provision the disposable review environment under the reviewing account through the existing platform lifecycle API. Never solve this by broadening production authorization or injecting another user's credentials.
