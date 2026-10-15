# Native browser lifecycle verification

This records protocol and local regression evidence, not live model qualification.

## Pinned native protocol

Codex CLI 0.162.1 was exercised without inference in a disposable home with owner files inaccessible and network isolated. The public probe initializes an app-server, configures a synthetic stdio MCP server, reads its catalog and resumes a valid synthetic rollout fixture. It never calls `turn/start` or authentication methods.

Updating the MCP configuration on the existing native child did not renew its environment: the catalog stayed at marker A after resume and reload. After confirmed child shutdown, a new child with environment B resumed the same persisted native thread and advertised B. The bounded persistence scan found neither marker in 69 disposable files (3,056,007 bytes inspected; largest file 2,158,912 bytes). Configuration uses `env_vars` names; the token stays in transient native child environment. No production rollout history is synthesized or replayed.

## Implemented lifecycle

Canonical personal, non-shared, default-interaction, full-access runs mint an exact owner/Chat/run/harness lease. A credential-free attempt nonce enters the launch descriptor. The bearer enters the runner through its existing private control socket and enters only the current native child environment. The initial browser bind waits for a connected, single-tool MCP catalog acknowledgement; a separate private release permits the first turn. Later browser turns require confirmed native child shutdown before same-thread resume with fresh authority. Ordinary non-browser turns retain the existing child lifetime.

Excluded runs explicitly disable only the reserved `matrix_shared_browser` MCP table and clear its environment names. Owner MCP tables remain untouched. Cancellation revokes browser authority independently of native acknowledgement. A lost acknowledgement is never replayed; bootstrap failure attempts a bounded physical stop and reports unconfirmed cleanup through the canonical callback.

Production background execution uses the existing user `systemd-run` service and control-group cleanup. Full access maps to native `danger-full-access`; no network namespace or new network exception is introduced. A subprocess regression exercises the actual stdio browser CLI and MCP catalog/action against a disposable loopback gateway.

## Local checks

Node 24.13.1 and pnpm 10.33.4: frozen installation and gateway build succeeded. The focused verification set passed 264 tests across 23 files, covering lease admission and exact-row drain, Claude strict MCP configuration and Steer drain, Codex private bootstrap and lost acknowledgements, canonical delayed dispatch, renewal and restricted transitions, readiness refusal, native reliability, launcher pinning and public probe bounds. Native/socket tests require permission to create disposable local sockets in restricted execution environments.

After review fixes, the extended native/browser regression set passed 622 tests and the gateway build passed on Node 24.13.1. Regressions cover a steered Claude replacement failing during browser cleanup, rejected Codex event-sink registration on start/resume, and oversized newline-free native probe output.

Claude Code 2.1.300 also passed a no-inference MCP connection check in a disposable home with owner files inaccessible and network isolated. A synthetic stdio server advertised `shared_browser`; token/port environment interpolation expanded and the 390,000 ms timeout configuration was accepted. This used the `mcp list` health command and a disposable user configuration. That subcommand does not observe `--mcp-config`, so this checks native transport and catalog compatibility rather than the production Chat launch configuration.

The native probes confirm supported no-inference lifecycle behavior. Synthetic subprocess regressions confirm Matrix wiring. Actual model use of the shared Chrome, owner Take over/Resume and account workflows remain separate required preview qualification; no success is claimed for them here. Claude 2.1.300 production Chat startup/tool catalog also remains a separate required preview check.

## Composition extraction boundary

Browser admission, launch configuration, control bootstrap and native-child lifecycle live in focused modules. The existing gateway composition entry point receives three registration-only dependency arguments; it remains 1,999 lines. Before adding further behavior there, extract coding harness registry/workspace-provider construction into a `server/coding-harness-services` module and canonical adapter assembly into a `server/canonical-chat-adapters` module. Keep owner identity, credential resolvers and the shared broker explicit typed inputs, return registered services/adapters, and validate the production registration chain before replacing the existing blocks. The current change extracts runner configuration and child lifecycle and adds no inline browser execution policy to gateway composition.

## Scoped CLI qualification and action guidance

The scope-runtime worker/profile pin now matches the qualified Codex 0.162.1 contract. A drift regression fences these independent package boundaries, and unqualified older/newer scope invocations remain refused. Sixty focused scope/acceptance tests and the scope-runtime typecheck passed. The installed native binary accepts the existing scope exec flags in its public help path; that is not evidence of isolated model inference. The profile digest changes, so the preview supervisor and gateway must restart together after active runs drain.

The model-facing browser description is shared by Pi, OpenClaw and the native MCP server. It gives schema-valid observed click/download examples, explains replacement of observation/ref placeholders and preservation of original-download receipts. A failed Pi invoice attempt exposed argument confusion; the description change has 33 focused contract/plugin/skill regressions passing. Successful invoice completion still requires a fresh live run.
