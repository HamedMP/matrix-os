# Codex 0.163.0 Settings protocol qualification

This qualifies the installed-version contract used by native Codex Settings login. It does not establish a real account login, model response or matched client/host acceptance.

## Official executable provenance

The official `codex-aarch64-apple-darwin.tar.gz` asset from [rust-v0.163.0](https://github.com/openai/codex/releases/tag/rust-v0.163.0) is 99,551,880 bytes. Its release-asset digest and independently downloaded SHA256 both equal `61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10`. The extracted executable SHA256 is `8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31` and reports `codex-cli 0.163.0`.

The retained full generated fixture has separate existing provenance in [Spec 532](../532-codex-0157-contract-qualification/evidence/qualification-01630.md). Its decompressed SHA256 remains `43e8c1495557ca91e33a63bbfae36c311c206253afae2974c979dbdf5d940c71`. A regression compares 32 transitive definitions and the consumed public method envelopes against qualified 0.162.1; unknown versions and changed native principals remain rejected.

## Actual bounded public-protocol check

The released Darwin arm64 executable was run in a newly owned empty HOME/CODEX_HOME, with an explicit environment allowlist and OS-enforced network denial. No real profile or credential was read. No global installation was changed.

- `--version`: exit 0, exact 0.163.0.
- `app-server generate-json-schema --out <owned-output>` without experimental flags: exit 0. Seven public authentication schemas are semantically identical to the previously qualified official 0.162.1 output.
- `app-server --stdio`: accepted `initialize`, `initialized` and `config/read` with `includeLayers:false`. The actual default `cli_auth_credentials_store` value was `file`.
- No `account/read`, `account/login/start`, account renewal, model list, turn or session method was invoked. The process exited 0 and was reaped; the empty fixture HOME was removed.

The seven compared files are `LoginAccountParams`, `LoginAccountResponse`, `AccountLoginCompletedNotification`, `CancelLoginAccountParams`, `CancelLoginAccountResponse`, `GetAccountParams` and `GetAccountResponse`. The five login/cancellation schema digests also match the existing 0.156.1 qualification.

## Production scope

Settings admits exact 0.156.1, 0.162.1 and 0.163.0, checking both initial availability and the executable again under the profile writer lease. A synthetic production HTTP composition exercises 0.163.0 through private native account/source completion, wrong-owner and version-drift denial, cancellation and same-email credential-generation recovery. Native profile custody, current principal, consent, Off and revision fences remain unchanged.

This qualification does not upgrade the global Codex tool pin, replace an existing account, grant Matrix AI access or bypass real-device acceptance. Linux x64 execution of this additional Settings-specific probe was not performed here; retained published schema provenance remains distinct from this actual Darwin process receipt.
