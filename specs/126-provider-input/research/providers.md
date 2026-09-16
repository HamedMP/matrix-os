# Research: Native provider input bridges

- Query: Identify native ask-input events, answer transports, adapter gaps and supported limitations for OM-239.
- Scope: mixed
- Date: 2026-09-11

## Findings

### Hermes

- `packages/gateway/src/chat/hermes-provider-adapter.ts:73` validates only `request_id`; `:596` projects only a title. Existing stdio client and approval registry provide a same-process control seam.
- Upstream single payload is `{request_id, question, choices, multi_select?}`; batch payload is `{request_id, questions:[{qid,question,choices,multi_select}]}`. Request blocks the running tool. Respond with method `clarify.respond`, params `{request_id, answer}`; batches use one response per question with `question_id: qid`. Return `status: ok` and optional remaining IDs; `status: expired` means it was not delivered. Handle `clarify.expire` as expiry, not success. Cancel uses empty answer without question ID. Bind the original native ID to owner/chat/run in a bounded registry; never reverse a hashed display ID. Native multi-select answer encoding still needs a renderer/tool fixture check.
- Sources: [server.py](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/server.py), `_clarify_block`, `_block`, `_respond`; [methods_prompt.py](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/methods_prompt.py), `clarify.respond` (1090). Latest source read through GitHub API; web cached line numbers differed from fresh API source. No local Hermes install found.

### Codex

- `packages/gateway/src/coding-agents/codex-app-server-events.ts:66,236` already normalizes `item/tool/requestUserInput` with bounded questions, option labels/descriptions, Other and secret fields.
- `codex-app-server-runner.mjs:705,1018` retains native RPC correlation and sends `{answers:{nativeQuestionId:{answers:[string]}}}`; the user-input path is already real, not a missing provider capability.
- `packages/gateway/src/chat/coding-provider-adapter.ts:211` drops question details; it lacks `submitInput`, although `packages/gateway/src/coding-agents/thread-store.ts:1733` and `provider-adapter.ts:126` expose the answer path.
- Recommended change: forward all safe question metadata plus correlation internally; bridge canonical submitInput to thread-store with the unresolved request correlation, exact run ownership, and canonical resolved projection. Preserve native request identity and never turn answers into follow-up prompts.
- Caveat: thread-store defaults to locally resolved events if the provider has no submitInput. Do not allow this fallback to claim a native answer was accepted for unsupported providers.

### Claude Code

- `packages/gateway/src/chat/claude-provider-adapter.ts:235` launches `stream-json` output, but has no input-control parser/submitInput. Its CLI transport currently cannot answer a blocked question.
- Official SDK supports `AskUserQuestion` via `canUseTool`; questions contain question/header/options/multiSelect. Return `{behavior:'allow',updatedInput:{...input,answers:{[questionText]:answer}}}`; deny on cancellation. Preserve original input and native question text only inside the adapter. Native documented limitation: 1–4 questions, 2–4 options; unavailable to Agent-tool subagents.
- Local installed SDK `sdk.mjs` confirms `--input-format stream-json --permission-prompt-tool stdio`, incoming `{type:'control_request',request_id,request:{subtype:'can_use_tool',tool_name,input,tool_use_id}}`, outgoing `{type:'control_response',response:{subtype:'success',request_id,response:permissionResult}}`. `control_cancel_request` aborts the pending callback. Safe alternatives: switch to SDK query with callback, or mirror this exact stream control protocol with piped stdin and initial user frame. A print-mode tool activity is not by itself evidence of a blocking request.
- Source: [official input docs](https://code.claude.com/docs/en/agent-sdk/user-input); installed `@anthropic-ai/claude-agent-sdk` under primary worktree `node_modules/.pnpm` inspected read-only. Verify behavior under each offered permission mode: permissions may resolve before canUseTool.

### Pi

- `packages/gateway/src/coding-agents/pi-provider.ts:45,53,715` explicitly runs noninteractive print JSON and documents input unsupported in that mode; ignored stdin prevents responses. This is a Matrix transport limitation, not a native Pi limitation.
- Native `--mode rpc` supports `extension_ui_request` dialogs with IDs and methods select, confirm, input, editor. Respond on stdin using `extension_ui_response`, same ID, and value/confirmed/cancelled. Dialog timeout can auto-resolve without client input. Notification/status/widget events are not answerable questions. These are extension dialogs; do not claim a built-in model ask-question tool without installing/testing an extension.
- Source: [Pi RPC protocol](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md). A proper implementation changes lifecycle from print process completion to RPC agent-end events, keeps stdin open, and adds bounded pending controls; focused transport tests are needed.

### OpenCode

- `packages/gateway/src/coding-agents/opencode-provider.ts:98` uses ignored stdin with CLI run JSON. Current adapter has no question-control method.
- Native Question service waits on deferred replies, publishes asked/replied/rejected events, and exposes reply(requestID, answers) and reject(requestID), plus list() of pending requests. Answers are ordered per-question string arrays. Existing CLI print transport should migrate to server/SDK event stream with native question reply/reject routes verified against the installed version. Do not simply write to CLI stdin or treat tool activity as a pending native question.
- Source: [OpenCode Question service](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/question/index.ts). Native support exists; route schema/version still needs verification (attempted raw server route URL was unavailable).

### OpenClaw

- `packages/gateway/src/chat/openclaw-provider-adapter.ts:282,381` uses agent and chat.send; event mapper has no structured input event. Local `/Users/nighxxx/AI/openclaw` version 2026.4.12 was searched read-only.
- Local `src/gateway/server-methods-list.ts:31–39,127–133` exposes exec approval request/wait/resolve plus agent/chat methods; no question/clarification reply method. `src/agents/openclaw-tools.ts` and gateway/tools search found no native ask-question tool or structured pending request bridge.
- Therefore no evidence supports advertising native ask-input for this installed version. Explicit capability limitation is appropriate until a native plugin/tool can hold a question and accept its answer. Do not substitute chat.send/Steer for same-run tool resolution or confuse execution approval with questions. This does not establish that all newer OpenClaw versions lack it.

## Related specs

- `specs/113-provider-neutral-chat-architecture/spec.md`: provider-neutral durable canonical identity and events.
- `specs/126-provider-input/design.md`: authenticated input control, persisted pending/resolved state, same-run continuation.
- `.specify/memory/constitution.md`: bounded resources, validated controls, tests-first and native SDK verification.

## Caveats / Not Found

- Worktree has no `.trellis/workflow.md` or `.trellis/spec/`; governing specs were read from `specs/`.
- No live authenticated provider turn was executed. Native transport evidence is source/documentation, not end-to-end proof.
- Current upstream source can differ from VPS installations. Verify/version native schemas before claiming support, especially Hermes batch answers and OpenCode server endpoints.
- Memory quick-pass found prior streaming work but supplied no input-specific contract; implementation recommendations above rely on current code/source reads.

### Pi RPC implementation and native probe (2026-09-11)

- Replaced print transport with `--mode rpc`, piped JSONL stdin, prompt and steer commands, and native `extension_ui_response` replies. `agent_settled` completes the run; `agent_end` alone does not (retry/continuation may remain). The same subprocess/session handles answers and steering.
- Source verified against v0.81.0: [RPC mode](https://github.com/badlogic/pi-mono/blob/v0.81.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts) emits `agent_settled` and supports select/confirm/input/editor dialogs. [Resource loader](https://github.com/badlogic/pi-mono/blob/v0.81.0/packages/coding-agent/src/core/resource-loader.ts) retains explicitly enabled CLI extensions with `noExtensions` set.
- `pi-owned-extension.ts` embeds a bounded, non-mutating ask_user tool. Each run writes the trusted source into an exclusive temporary directory, explicitly loads it while disabling owner extensions/skills/context, and removes it on completion. This ships through normal TypeScript output and needs no separate host-bundle asset copy.
- Native CLI probe used temporary Pi 0.81.0 with isolated HOME, no owner credentials and no model call. Its active tools were exactly `["read","ask_user"]`. A temporary probe command emitted `extension_ui_request(method=select)`, accepted the matching `extension_ui_response(value=North)`, emitted `MATRIX_INPUT_PROBE_PASSED`, and returned successful prompt acknowledgement. This verifies extension loading and real dialog transport, not a model-triggered complete Chat turn.
- Initial temporary installation selected companion pi-agent-core 0.81.1 via upstream caret dependencies and failed before prompt handling with “No default stream function configured.” Pinning the temporary probe's pi-agent-core, pi-ai and pi-tui to 0.81.0 corrected the upstream mismatch. Repository dependency manifests/lockfile were unchanged. Probe installation used the seven-day minimum release age and disabled install scripts; all temporary package/source files were removed afterward.
- Focused regressions cover answer frames for select/confirm/input/editor, timeout resolution, same-process steering, abort, invalid/stale replies, and existing provider behavior. A real authenticated model-triggered same-run Chat exchange remains required for end-to-end acceptance.
