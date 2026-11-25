# Published Codex 0.172.0 qualification

[ENG-571](https://linear.app/matrix-os/issue/ENG-571/fixcodex-qualify-provider-contracts-for-01720) restores the [Codex Provider Contracts workflow](https://github.com/HamedMP/matrix-os/actions/runs/45371072420), which rejected the newly published exact version on Linux x64 and Darwin arm64.

## Published artifacts

- [Official 0.172.0 release](https://github.com/openai/codex/releases/tag/rust-v0.172.0).
- The tagged `codex-rs/exec/src/exec_events.rs` is byte-identical to the retained 0.158 fixture. SHA-256 is `dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5`.
- The official Darwin arm64 npm binary reports `codex-cli 0.172.0`. Running `app-server generate-json-schema --experimental` produced schema SHA-256 `b0ba23a68f1985e614f2036c630f1b86307951f6348607bea3ce48f94b724ee6`. Both original hosted jobs reported the same digest.

## Reviewed changes from 0.171.0

- The `turn/completed` digest changes because `CodexErrorInfo` adds `apiKeySpendLimitExceeded`, `projectSpendLimitExceeded`, and `organizationSpendLimitExceeded`. Matrix's existing terminal error handling keeps these typed failures generic and does not persist provider error text.
- The routine `thread/start` digest changes through the optional, nullable `daybreakProgramPropagationEnrolled` field. Existing request fields, required fields, and authorization stay the same. Matrix leaves that field unset. The other three routine requests and all dynamic-tool definition digests match 0.171.0.
- The rest of the delta covers optional app-tool approval reviewer metadata, optional Bedrock provider IDs, model access and thread propagation metadata, realtime input metadata, and an optional thread sampling model override. The client request, server request, and notification method sets match 0.171.0. All other consumed server digests match.

## Runtime verification

The exact Darwin arm64 executable completed fresh, loaded-resume, and cold-resume turns against the retained loopback Responses and isolated MCP fixtures. Each turn returned the expected scoped tool output, and each launch reported `workspaceWrite` with network access disabled. Forced initialization cleanup and all ten Python probe tests passed. This covers the isolated CLI protocol and lifecycle. Live account sign-in and product surface acceptance were outside this run.

The managed CLI pin and the separate Settings-native-auth allowlist keep their existing versions.

The regression tests first reproduced the unknown-version rejection. With the reviewed records in place, the production verifier accepts these bytes for both target keys. The regression suite checks the complete schema delta, rejects altered consumed payloads after a whole-schema hash refresh, and drives the production app-server runner with a schema-validated `projectSpendLimitExceeded` frame. The failed event stays generic and omits the provider message.
