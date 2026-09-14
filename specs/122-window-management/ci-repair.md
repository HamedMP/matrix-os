# CI repair after #1596

The full main run at `d80d821b24df5e97271bbd7287f38705ad18f106`
failed two Web Canvas geometry tests and a shared Chat history race test.
The host release correctly stopped at its CI gate.

## Window and Chat regressions

- Canvas group/minimap tests now explicitly select Web Canvas. Their world-coordinate
  assertions remain unchanged; Web Desktop movement constraints still apply in Desktop mode.
- Every canonical Chat recovery advances the request generation before network reads.
  Older history pages and older recoveries cannot overwrite the newer canonical snapshot.
- A deterministic overlapping-recovery regression failed before the fix. The existing
  history-page race test also settles both requests within React's `act` boundary.
- The shared controller supplies the same behavior to all renderers that use shared Chats;
  no layout, copy, or new user-visible action changes in this repair.

## Codex 0.154.0 compatibility review

Compared the official `rust-v0.153.4` and `rust-v0.154.0` exec sources and generated
experimental app-server JSON schemas from both published macOS ARM64 packages.
Package tarballs were checked against the registry's SHA-512 integrity values before execution.
The new generated schema matches both targets in the
[scheduled contract run](https://github.com/HamedMP/matrix-os/actions/runs/34463718588).

| Boundary | Review result |
| --- | --- |
| Exec JSONL events | Source bytes identical; SHA-256 `c404928e0f2a463e19d1b263081c9d5e0380aec9f651a05ee0766f7bb7527f32` |
| App-server schema | Linux x64 and macOS ARM64: `24df528acec2952e6b96c1c2b061f98e60177d059e12c90cf318621380c9de9e` |
| `item/permissions/requestApproval` | `cwd` changes from `AbsolutePathBuf` to `LegacyAppPathString`. Matrix still rejects permission-profile grants. The event fixture covers a relative legacy path without exposing or granting it. |
| `mcpServer/elicitation/request` | Adds `openai/userVerification` with challenge/title/description, without the form request fields. The existing fallback returns a correlated unsupported-request error; a runner test verifies no approval or challenge is published. Existing form confirmations continue through explicit user decisions. |
| Other required server methods/notifications | Transitive payload digests unchanged |

Both contract registries retain earlier verified versions. The shared install version,
VPS installers, and local development Docker pins advance together. No new permissions
or automatic device verification are enabled. No dependency manifests or lockfile change.

Sources: [exec source](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/exec/src/exec_events.rs),
[protocol source](https://github.com/openai/codex/tree/rust-v0.154.0/codex-rs/app-server-protocol).
