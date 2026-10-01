# Codex 0.159.3 provider contract qualification

The [baseline workflow](https://github.com/HamedMP/matrix-os/actions/runs/36789780815) installed published 0.159.3 on linux-x64 and darwin-arm64 and failed the intentional unknown-version guard. This upstream patch appeared during company-drive PR delivery; accepting it requires exact evidence rather than disabling the guard.

## Exact upstream artifacts

- Official [tagged exec source](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/exec/src/exec_events.rs) SHA-256: `dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5`. Independently downloaded and equal to the qualified source fixture.
- Both actual published CLI-generated full app-server schemas in the baseline workflow have SHA-256 `7243ba241962af92ca60581f1a81808ebda4212a800f8b205f54703bcfd508c5`. All 22 required method/notification digest rows match the qualified 0.159.2 contract, including transitive definitions.
- Independent Linux generation with the exact published 0.159.3 binary produces the same complete schema digest. Existing 0.159.0 fixtures remain byte-identical; no new schema approximation is introduced.

## Native isolated probe

The repo-owned `probe-patch.py` now explicitly admits 0.159.3 for qualification only. With `CODEX_SPIKE_VERSION=0.159.3` and the exact published Linux binary, the unchanged assertions passed: fresh turn completed with scoped MCP sentinel A, loaded resume retained A, and cold-process resume completed with C. Each turn completed one MCP call. The fixture uses an isolated HOME/CODEX_HOME, synthetic credentials, and a local fake Responses endpoint, then cleans its temporary processes and files. This is not paid provider, macOS native lifecycle, or network-isolation evidence. The known loaded-registration retention behavior is unchanged.

## Scope and gates

Exact-version tests failed before adding the explicit records and pass afterward. Existing records remain, unknown versions still fail closed, and the installed runtime pin stays 0.156.1. No provider account or customer runtime pin changes are made. Full CI, both-target proposed-head provider verification, and current-head review remain separate acceptance gates recorded on the PR.
