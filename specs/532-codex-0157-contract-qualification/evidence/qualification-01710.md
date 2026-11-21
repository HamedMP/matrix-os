# Published Codex 0.169.1, 0.170.0 and 0.171.0 qualification

[ENG-467](https://linear.app/matrix-os/issue/ENG-467) restores the scheduled provider-contract gate after published `@openai/codex` moved past the 0.169.0 qualification ([failing run](https://github.com/HamedMP/matrix-os/actions/runs/44752199217): `Codex 0.171.0 is not verified`). This adds exact records for every stable release since 0.169.0. It keeps historical records, unknown-version rejection, the installed/runtime-selected 0.162.1 pin and the separate Settings-native-auth allowlist.

## Published artifacts

- Official releases: [0.169.1](https://github.com/openai/codex/releases/tag/rust-v0.169.1), [0.170.0](https://github.com/openai/codex/releases/tag/rust-v0.170.0), [0.171.0](https://github.com/openai/codex/releases/tag/rust-v0.171.0).
- Tagged `codex-rs/exec/src/exec_events.rs` is byte-identical in all three: SHA-256 `dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5`, the retained 0.158 fixture.
- `pnpm dlx @openai/codex@<version> app-server generate-json-schema --experimental` on Linux x64 produced:
  - 0.169.1: `d2d0612646b0739dd264067ef944442a5485e44529c793bebf3985e9a9df6cfc`, identical to 0.169.0. The same command also reproduced 0.169.0's recorded bytes exactly.
  - 0.170.0: `e3f3b0a75918871280e808a186b33f583ec4a9eb1a1038c2bd13d2ae1c5dc8db`.
  - 0.171.0: `fe3f0cc67ec5f581743c802ee6e1369c32328d24f91faf4c6f5c697935db642c`.
- The gzip fixtures `tests/fixtures/codex-0170/` and `codex-0171/` retain those exact bytes. Darwin arm64 bytes are recorded as target-independent, like 0.169.0; the hosted macOS target check must confirm that on the PR head.

## Complete reviewed delta

Each `reviewed-delta.json` lists every changed path against the previous release. The regression removes or restores only those paths, then compares the whole remaining tree. Exact-byte hashing independently protects the full new tree. Matrix does not enable any new upstream API.

**0.169.0 → 0.170.0 (9 paths).** `AgentMessageDisplay` becomes a versioned `show`/`hide`/`block` union with helpline annotations, replacements and block reasons. It is reachable only through the optional `agentMessage.moderation.display` metadata, which Matrix does not read. `UserVerificationVerifyResponse` adds optional `biometricType` context; `proof` stays the only required field. One Guardian description is expanded. Request and notification method lists are unchanged. Consumed `item/started`, `item/completed` and `turn/completed` digests change through the display union only.

**0.170.0 → 0.171.0 (39 paths).**
- Five client requests are added (`modelProvider/default/set`, `thread/realtime/list`, `thread/search/cancel`, `thread/search/stream`, `thread/search/stream/cancel`) and one notification (`thread/search/partial`). Matrix invokes none of them.
- The `currentTime/read` server request and its params/response are removed. Matrix never handled it.
- An optional, nullable `environmentId` ("registration scope") appears on MCP elicitation params, MCP tool-call thread items and MCP status/resource/OAuth/tool-call definitions. Required fields are unchanged. This is the only change to consumed `mcpServer/elicitation/request`. Matrix's elicitation parser passes it through and makes no authorization decision on it.
- `CodexErrorInfo` adds `bioPolicy`. Matrix maps no typed reason for it, so it stays a generic failed turn and its private message is not persisted.
- Also added: account-update reason, OpenTelemetry header helpers, thread realtime listing/transcripts, thread search cancel/partial, thread list ID filter. `Project.position` is removed. Four descriptions change.
- The other five consumed approval/request payload digests (command, file-change, permissions, user-input, dynamic tool call) are unchanged.

## Verification and limits

- Routine bridge: `initialize`, `thread/start`, `thread/resume`, `turn/start` and all three dynamic-tool definitions keep their 0.169.0 digests in all three releases. The routine mutation guards run against each new fixture after a whole-schema hash refresh.
- Regression red: the new qualification suite failed 5/7 against the old contracts (latest pin, missing exec record, missing routine records). Green after the paired records were added. Unknown 0.170.1, 0.171.1 and 0.172.0 fail closed. Altered vendor bytes fail the hash guard. A changed permissions or elicitation request payload fails semantic verification even with a recomputed whole-schema hash.
- A real-adapter subprocess fixture drives the production app-server runner with the new block display, a scoped MCP tool call and a `bioPolicy` failure. Completed turns keep the answer, failed turns stay failed, and display, scope and private error text stay out of the transcript. Fake provider only; no credentials or paid inference.
- The exact official Linux x64 0.171.0 executable passes the retained isolated MCP/fake-Responses probe (`probe-patch.py`, which now admits 0.171.0): fresh, loaded-resume and cold-resume turns complete with the expected scoped sentinels. Every turn reports `workspaceWrite` with `networkAccess: false`. `--verify-init-cleanup` and the ten Python fixture controls pass. This is not live account, Darwin process-lifecycle or network-isolation qualification.
- Historical 0.164–0.169 qualifications now reconstruct the prior `mcpServer/elicitation/request` pin alongside their other historical digests. Current verification stays strict; no verifier guard is relaxed.
- Current-head full CI, both hosted target schema generators, Greptile 5/5 and engineer review remain merge gates. No UI or installed-tool behavior changes.
