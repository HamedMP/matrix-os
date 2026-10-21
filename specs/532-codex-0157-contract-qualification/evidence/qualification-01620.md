# Published Codex 0.162.0 qualification

The provider-contract gate discovered a newly published CLI while the Jev foundation was awaiting merge. This maintenance qualifies its consumed protocols; it does not change provider selection, account routing, installation pins, authentication or approvals.

## Sources and bytes

- [Official release](https://github.com/openai/codex/releases/tag/rust-v0.162.0).
- [Tagged exec source](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/exec/src/exec_events.rs): unchanged from the retained fixture; SHA-256 `dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5`.
- Published Darwin arm64 archive SHA-256: `98e9413a1bd167ae573723939ff178e6d44f1bb21d5cda960dbeb2fa65f49104`. Its CLI reports `codex-cli 0.162.0`.
- `app-server generate-json-schema --experimental` on that binary produces SHA-256 `e4e7f0c7d3fd77c48cd8619cad2bf2b315d860ab006ad5a7ebe44f6e32e666c1`. The retained gzip fixture decompresses to those exact bytes.
- CI run [37830663177](https://github.com/HamedMP/matrix-os/actions/runs/37830663177) generated the same full schema and consumed payload digests independently on Linux x64 and Darwin arm64 before refusing the unqualified version. This is byte evidence, not a passing qualification run.

## Consumed changes and behavior

Among required methods/notifications, only `item/started`, `item/completed` and `turn/completed` digests change. All five approval/input methods and the remaining three notification payload digests are unchanged.

The referenced `ThreadItem` adds optional nullable `model` and `reasoningEffort` metadata on `subAgentActivity`. `Turn` adds optional nullable `rootTurnId`. Removing those exact additions restores the previous fixture structures, including required fields. `MisalignmentErrorDetails` adds optional nullable `reviewTarget`; removing it restores the prior error structure. Matrix does not implement target-based continuation. Typed failure classification does not infer authentication or grant continuation from this opaque field. Existing passthrough/ignored-item handling preserves compatibility without exposing those identifiers.

`MessagePhase` adds `partial_answer`: stable text may be followed by more tools/output. The lifecycle schema now explicitly accepts it. An item completion closes its message; only `turn/completed` terminates the turn. A subprocess regression verifies text delivered without deltas, later tool execution, final text, two message completions and one final turn completion. It fails on the previous parser, which silently omitted partial-answer text. Unknown phases remain rejected.

This is not a claim that the entire upstream protocol is additive: upstream also removed `namespaceTools` from `ModelProviderCapabilitiesReadResponse`. Matrix does not call that endpoint or consume the removed field. New request fields and unconsumed response variants do not alter Matrix's request builders. Exact schema hashes still reject unreviewed upstream changes.

## Verification and maintenance boundary

The new qualification/version tests and partial-answer regression fail before maintenance. Focused provider-contract, event normalization, native runtime and reliability suites verify the resulting implementation. Both published-target CI checks must pass on the new PR head before merge; prior-head CI does not qualify this update.

The large app-server runner is modified only by adding the explicitly reviewed enum value; no new orchestration logic is added. Future lifecycle behavior should first extract its schemas/normalization into a focused module with the same subprocess contract tests. That refactor is outside this qualification, which preserves existing completion and authorization boundaries.

No Codex inference, login, Gmail operation or production deployment was performed to generate this protocol evidence.
