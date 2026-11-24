# Managed Codex pin promoted to 0.171.0

[ENG-541](https://linear.app/matrix-os/issue/ENG-541) moves the installed/runtime-selected pin from 0.162.1 to 0.171.0. The Chat model selector reads the live `model/list` catalog from the installed CLI, and 0.162.1 predates GPT-6.2-Sol and GPT-6.2-Astra.

## Cause

Same machine, same account, `app-server --stdio` `model/list`:

- 0.162.1: default `gpt-6.1-terra`; no GPT-6.2 entries.
- 0.169.0, 0.170.0 and 0.171.0: default `gpt-6.2-sol`, plus `gpt-6.2-astra`.

## What moved

`CODEX_VERIFIED_VERSION`, the scope-runtime harness pin (profile digest `a12c383c…4e722`), both customer-VPS installers, both Dockerfiles and the supervisor acceptance script. Provider contracts for 0.171.0 were already qualified in [qualification-01710.md](qualification-01710.md). New Terminal installations use the qualified version. Background reconciliation preserves any healthy existing Terminal executable, including 0.162.1.

## Upgrade order

The host-bundle build downloads and checksums the exact Linux binary, verifies its version, and stages it as `bin/matrix-codex`. On the first upgrade, the running predecessor already backs up and installs flat host binaries before restarting the supervisor. Its rollback restores the prior scoped binary or removes the new file when the predecessor had none. Codex needs no separate network installation during the service stop.

The scope supervisor checks the release binary and mounts only that file read-only into the shared Chat runtime. On a managed VPS with the previous 0.162.1 Terminal install, the native Chat selector also uses the release binary for both catalog discovery and execution. It leaves the Terminal CLI and its account state in place. A later Terminal upgrade is detected by the native catalog and credential caches. Native Chat still applies its compatibility checks, and shared Chat continues using the release pin.

## Settings device login

The exact-version allowlist adds 0.171.0. Against the retained 0.164.0 schema, the transitive public auth contract (32 definitions) differs only by an optional `requiredHumanApproval` capability, optional `GetAccountResponse.userId`, optional ChatGPT `workspaceName`, and a new `gcp` account kind. Matrix sends none of the first, reads none of the next two, and its bounded account reader rejects the last. The six consumed request variants and `account/login/completed` are identical. 0.165.0–0.170.0 stay unadmitted.

## Verification and limits

- Production catalog source against the official Linux x64 0.171.0 executable: parses, default `gpt-6.2-sol`.
- `tests/scope-runtime/codex-published-binary.test.ts` with that executable: strict config accepted, no tools, credentials or stored Responses. Fake provider; no paid inference.
- The routine Codex fixture now reports the managed release and validates frames against the retained 0.171.0 schema; the restoration helper keeps the historical 0.162 boundary explicitly.
- Not covered: a live Settings device login on 0.171.0, a real Chat turn on GPT-6.2, and a VPS upgrade from 0.162.1. These need a preview VPS before fleet rollout. The scope profile digest changes, so the preview supervisor and gateway must restart together after active runs drain.
