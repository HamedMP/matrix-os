# Published Codex 0.165.0 qualification

The [main Codex Provider Contracts run](https://github.com/HamedMP/matrix-os/actions/runs/40663530717) resolved exact `@openai/codex@0.165.0` and failed closed because the latest reviewed release was 0.164.0. This change admits only 0.165.0 in the paired coding-agent contracts after reviewing the official schema delta. The installer/runtime-selected `CODEX_VERIFIED_VERSION` remains 0.162.1; the separate Settings-native-auth allowlist remains unchanged.

## Published artifacts

- [Official release](https://github.com/openai/codex/releases/tag/rust-v0.165.0), published `2026-10-27T20:09:38Z`. Exact published Darwin arm64 and Linux x64 binaries both report `codex-cli 0.165.0`.
- [Tagged exec source](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/exec/src/exec_events.rs): SHA-256 `dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5`, byte-identical to the retained 0.158 fixture; all eight required event names remain unchanged.
- Both published target binaries independently generated identical `app-server generate-json-schema --experimental` output: 905,488 bytes, SHA-256 `8c2a3adebb3e0da97f9b1efaf686f8d14f9969436879ade25a4b1b208ec65cd7`. Exact bytes are retained in `tests/fixtures/codex-0165/app-server-schema-0165.json.gz`.
- Darwin used exact `pnpm dlx @openai/codex@0.165.0`. Linux used the [official npm platform package](https://registry.npmjs.org/@openai/codex/0.165.0-linux-x64) under an existing amd64 Docker test runtime. Its downloaded tarball was verified against registry integrity `sha512-FotDc7bVHwaommtsdDP8PPrH0a5IwC/t8H/LhdEcH4EBqgeYFRCtptiHcuwgvNRCLbTbOyFE/Ur6GzYCljgaSQ==` before extraction. This is local native-binary execution under amd64 emulation, not a claim of native GitHub Linux-runner acceptance.

## Complete reviewed delta

The regression removes exactly these reviewed additions from 0.165.0 and compares the entire remaining JSON tree to the retained 0.164.0 fixture. Existing definitions and method variants otherwise remain equal, including descriptions and reference targets.

- One client request, `thread/memory/read`, and its `ThreadMemoryReadParams`/`ThreadMemoryReadResponse` definitions were added. The request requires a started/resumed thread ID; its response contains a nullable memory summary. Matrix does not call this method.
- The `Account` union adds `gcp` for externally managed Google Cloud Vertex AI credentials. Existing account variants remain equal. This change does not authorize a new Settings login method or widen the separate Settings-native-auth version allowlist.
- `CodexErrorInfo` adds `modelNotFound`. This changes only the consumed `turn/completed` transitive semantic digest, to `d775b4d4e65c194a34726c88625fd88f71e5ffc00cd5ba5a6bc64ac913a90055`; the other ten consumed request/notification digests remain unchanged. The production error classifier treats this new typed error generically and does not misclassify its raw text as an authentication failure.
- Four optional properties were added: network `reviewDomains`, fork `attachToSource`, thread-list `attachedToThreadId`, and sample `threadSource`. No required list changed. Matrix does not send these new fields; no network approval or sandbox policy is changed.

## Verification

- Red: the new exact-byte qualification suite ran against the original 0.164.0 contracts: four cases failed at exact-version admission; the full-delta case passed independently. Green: all five cases pass after the paired 0.165.0 records and reviewed `turn/completed` digest were added. Unknown 0.165.1 and older gaps still fail closed; changed bytes still fail the digest check.
- Six focused qualification/checker/parser suites pass: 40 tests, including historical 0.163.0 and 0.164.0 qualification. Historical tests reconstruct their original latest-version/digest context rather than relaxing the live verifier.
- All ten coding-agent Codex runtime/parser/control suites pass: 92 tests.
- Both actual target schema outputs pass `scripts/check-codex-exec-contract.mjs 0.165.0` with their real target identity.
- Both exact published binaries pass the existing isolated no-paid fake Responses/MCP lifecycle probe: fresh turn returns sentinel A, loaded resume retains A, and cold-process resume uses C. Every turn completes with `workspaceWrite` and `networkAccess: false`. The fixture uses temporary HOME/CODEX_HOME and no account credentials or paid inference; this is not live provider or network-isolation qualification.
- Forced initialization-cleanup controls terminate the real throwaway process and close its handles. The retained fake Responses/RPC/turn-polling controls pass (10 tests).

Current-head GitHub target checks, full CI, and review remain required before merge. Historical main failures are not rewritten by this local qualification.
