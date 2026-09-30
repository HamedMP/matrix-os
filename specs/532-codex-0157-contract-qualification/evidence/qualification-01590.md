# Codex 0.159.0 qualification

The [baseline workflow](https://github.com/HamedMP/matrix-os/actions/runs/36588441467) installs official 0.159.0 on both linux-x64 and darwin-arm64, verifies the actual target/version and generates the same protocol bytes, then rejects the intentionally unverified version. This is separate from the Jev feature.

## Exact artifacts and semantic review

- Official [tagged exec source](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/exec/src/exec_events.rs): SHA-256 `dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5`, byte-identical to the existing 0.158.0 fixture, which is reused.
- Experimental schema from actual published `@openai/codex@0.159.0`: SHA-256 `7243ba241962af92ca60581f1a81808ebda4212a800f8b205f54703bcfd508c5`. Local darwin-arm64 generation matches both baseline jobs. Compressed exact bytes are pinned at `tests/fixtures/codex-0159/app-server-schema-0159.json.gz`.
- Complete parsed comparison: no added, removed or changed ClientRequest, ServerRequest or ServerNotification variants. Only v2 definitions differ: `CodexErrorInfo` adds `tooManyDenials`; `ListMcpServerStatusParams` adds nullable optional `serverName`; `ThreadItemsListParams.cursor` extends string/null to a string/anchor union, adding `ThreadItemsListAnchor` and `ThreadItemsListCursor`; `Turn.error` documents errors on failed or interrupted turns. Existing string cursors and omitted optional parameters remain valid.
- Ten consumed request/notification transitive digests are unchanged. `turn/completed` changes to `cbba93d35c49dee9ac42aa7bca7eeeeb935e0cc89c223c31094a27660427f57f` through the error enum/description. The adapter already accepts bounded terminal status and ignores raw error payloads. The regression starts an actual Matrix runner with a synthetic native notification carrying `tooManyDenials`, asserts aborted outcome/tool cancellation, and verifies private synthetic error/details do not enter the transcript. This test does not invoke a real provider.

## Native no-paid lifecycle probe

Reproduce using the exact published target binary:

```sh
CODEX_SPIKE_VERSION=0.159.0 CODEX_SPIKE_BINARY=/absolute/path/to/exact/codex \
  python3 specs/532-codex-0157-contract-qualification/evidence/probe-patch.py
```

The fixture retains isolated HOME/CODEX_HOME, synthetic credentials, local fake Responses and stdio MCP, exact thread/turn completion matching, bounded waits and cleanup. Its version option permits only the two explicitly covered fixture versions; default remains 0.157.1. Final local exact-0.159.0 execution passed with the repo-owned fixture: fresh A, loaded resume retaining A, cold new-process resume C. All three distinct started turns completed and each made exactly one MCP call. The known loaded-session registration replacement limitation remains; no account/network isolation or production acceptance claim follows. No real model inference, Gmail mutation, credentials or installer promotion occurs.

## Gates

Red: the real checker rejects 0.159.0; updated qualification assertions fail before contract records change. Only the exact new records/latest pointers and reviewed terminal notification digest change. Previous records and unknown-version rejection remain. Current-head local focused tests, fresh native fixture, root typecheck/pattern scan, both-target CI and Greptile results are recorded in the PR. The 89 focused exec/app-server contract/runtime/reliability tests, ten fixture-control tests, real artifact checker, root typecheck and pattern scan passed locally. No broad local-suite pass is inferred from the native probe.

Public docs are assessed separately on any later installer promotion. This qualification does not change the installed product/runtime version or require a public-site behavior update.
