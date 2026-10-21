# Codex 0.160.0 provider contract qualification

The [baseline CI run](https://github.com/HamedMP/matrix-os/actions/runs/36940588438) installed published 0.160.0 on linux-x64 and darwin-arm64 and failed the intentional unknown-version guard during app-builder delivery.

## Exact upstream artifacts

- Official [tagged exec source](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/exec/src/exec_events.rs) was independently downloaded. SHA-256: `dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5`. It is byte-identical to the retained 0.158 fixture.
- Both published CLI-generated full app-server schemas in baseline CI have SHA-256 `7243ba241962af92ca60581f1a81808ebda4212a800f8b205f54703bcfd508c5`. All required semantic method/notification digests match the reviewed 0.159.3 contract, including transitive definitions.
- Independent generation using the exact published `@openai/codex@0.160.0` on darwin-arm64 produced the same full digest and bytes as the retained 0.159 fixture. Reuse those fixtures instead of duplicating unchanged bytes.

## Isolated native probe

The existing `probe-patch.py` explicitly admits 0.160.0 for qualification only. Against the exact published CLI, unchanged assertions pass: fresh turn completes scoped MCP sentinel A; loaded resume retains A; cold-process resume completes C. Each turn completes one MCP call. Forced initialization failure also cleans its child process, pipes, selector, and temporary files.

The probe uses isolated HOME/CODEX_HOME, an auth-disabled local mock provider and stdio MCP tool. It does not prove paid provider behavior or network isolation. Known loaded-registration retention behavior remains unchanged.

## Scope and acceptance gates

Exact-version tests failed before adding the records, then passed afterward. Earlier qualification records remain; unknown 0.160.1 fails closed. Runtime pin remains 0.156.1. No parser, account, permission, funding, or customer runtime changes. Both-target proposed-head CI and current-head review remain required. Public agent-skill guidance ships separately in the app-builder documentation PR; this compatibility record changes no user-facing capability.
