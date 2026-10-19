# Published Codex 0.163.0 qualification

The shared [provider-contract run](https://github.com/HamedMP/matrix-os/actions/runs/38832779395) installed 0.163.0 on Linux x64 and Darwin arm64, generated its experimental schema, and stopped at the intentional unknown-version guard. Its workflow, checker and contract records were identical to main. This maintenance qualifies that exact upstream version; it does not promote the installed customer tool or add upstream capabilities to Matrix.

## Exact upstream artifacts

- [Official release](https://github.com/openai/codex/releases/tag/rust-v0.163.0), published October 15, 2026.
- [Tagged exec source](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/exec/src/exec_events.rs): SHA-256 `dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5`, byte-identical to the retained `tests/fixtures/codex-0158/exec-events.rs` and verified 0.162.1.
- Official Darwin arm64 archive: 99,551,880 bytes, SHA-256 `61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10`, checked against the release-asset digest before execution. The extracted CLI reports `codex-cli 0.163.0`.
- Exact local `app-server generate-json-schema --experimental` output: 890,029 bytes, SHA-256 `43e8c1495557ca91e33a63bbfae36c311c206253afae2974c979dbdf5d940c71`. Both failed CI jobs independently printed that same full-schema digest. The retained `tests/fixtures/codex-0163/app-server-schema-0163.json.gz` decompresses to those exact bytes.
- All five consumed server requests and six consumed notifications retain their previous transitive semantic digests on both targets. Required protocol pins remain unchanged.

The repository-tagged golden JSON omits experimental protocol surfaces and is not interchangeable with the published CLI's experimental output. The retained fixture comes from the exact published binary, not the tagged golden or a constructed subset.

## Complete generated-schema comparison

The new focused regression removes only the following reviewed additions and compares the entire remaining schema to the previous experimental fixture, including referenced definitions and required-field lists. No existing field or method is removed or changed.

- Client requests: `thread/items/read`, `thread/readState/update`. Notification: `thread/readState/changed`.
- Eight v2 definitions: `ThreadItemsReadParams`, `ThreadItemsReadResponse`, `ThreadReadState`, `ThreadReadStateChangedNotification`, `ThreadReadStateOperation`, `ThreadReadStateUpdateParams`, `ThreadReadStateUpdateResponse`, `ThreadUnreadPosition`.
- Optional fields: output-text content annotations/logprobs; environment websocket request ID; realtime voice-list v3; encrypted content on seven response-item variants and status on message/function-call response items; experimental thread-fork prediction mode; excluded thread-list IDs; thread-list/read read states; tool-output retention.
- Sixteen realtime voice enum additions. The regression records every new value and preserves all existing values.

These 29 added paths and one enum expansion do not alter Matrix-consumed payloads. Matrix does not start calling the new requests, projecting read-state events, retaining tool output, exposing opaque upstream fields, or granting new permissions. No runtime parser, request builder, approval/auth/sandbox policy, checker or workflow changes are needed.

## Exact native no-paid process evidence

The repo-owned `probe-patch.py` initially rejected 0.163.0 at its explicit exact-version allowlist. This change adds only that version to the allowlist. The existing probe and helpers run the exact published Darwin arm64 CLI against synthetic stdio MCP and a loopback fake Responses endpoint, without real account credentials or provider access.

The genuine local process passed: fresh turn uses sentinel A; loaded resume retains A despite a proposed replacement B; cold-process resume uses C. All three turns complete with the expected scoped MCP result. The existing `workspaceWrite`/`networkAccess:false` assertion remains enforced. The known loaded-registration replacement limitation is preserved rather than interpreted as live replacement support.

A separate forced-initialization-failure exercise passed child, selector and pipe cleanup. The outer process deadline is 90 seconds; RPC waits, retained notification count/bytes and read buffers remain bounded. Fresh private child HOME/config state and an environment allowlist exclude owner credentials/history. The loopback fixture requires local socket permission; the sandbox initially refused the bind, and the same bounded fixture passed with that permission. No paid inference, login, deployment, private history or production endpoint was used.

## TDD and remaining landing gates

The exact-version qualification tests first failed on main at `Codex 0.163.0 is not verified`; the full structural-delta control passed before any record changed. Adding the paired exact-version records makes the verifier accept 0.163.0 on both target cases. The tests still reject 0.163.1 with the same valid bytes and reject changed schema bytes. Earlier verified records and unknown gaps remain preserved; 0.162.2 is now an unverified older gap, not an admitted version.

`CODEX_VERIFIED_VERSION` and both host installer pins stay at 0.156.1. Public product behavior and documentation remain unchanged. This PR does not edit Browser work, global CI controllers or unrelated native stacks.

Local process/schema evidence and focused tests do not replace exact-head Greptile 5/5, full CI or the actual provider-contract workflow on both Linux x64 and Darwin arm64. Those gates must pass on the final published head before merge; the baseline failed run establishes upstream provenance only.
