# Native protocol qualification

Protocol observations below are separate from the Matrix source, owner authorization and routine backend integration tests. No real provider or account was used. They do not establish live end-to-end acceptance.

## Claude native hook

The locally cached `@anthropic-ai/claude-agent-sdk-linux-arm64` package **0.3.240** contains a native executable reporting **2.1.240 (Claude Code)**, SHA256 `72be65c43d1db48e91abbe65254037f29fb7887d846a3890dcd4890b00265493`. Package and native CLI versions are distinct.

Parent-owned probes ran these exact bytes in an existing cached Linux ARM64 Node 24 image (`sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4`). Before launch, external container inspection checked network-none, non-root UID/GID 65534, read-only rootfs, all capabilities dropped, no-new-privileges, finite memory/CPU/PID/tmpfs limits and exactly three public read-only mounts. An internal gate independently checked only loopback/no routes, no Docker socket, denied rootfs writes and the native digest. Empty owned HOME/config/cwd and a synthetic loopback Anthropic SSE endpoint replaced ambient state. No host credentials, real provider key, account or Docker socket entered the fixture.

| Probe | Actual observation |
| --- | --- |
| Bypass rewrite | Matching initialize ACK before input, correlated Bash PreToolUse callback; the next native API request contained a nonerror tool_result with only the rewritten harmless marker. Native and outer exit 0. |
| Bypass deny | Correlated native error tool_result contained neither original nor rewritten marker. Native and outer exit 0. |
| Unanswered one-second callback | Native sent matching control_cancel_request, then an error tool_result containing neither marker. Native and outer exit 0. This is an observation for this pin, not a universal timeout guarantee. |
| Interrupt pending callback | Matching callback cancellation and interrupt ACK, native error result and native exit 1; outer fixture exit 0. There was no subsequent API tool_result, so no result-based marker outcome is claimed. |
| Plan deny | Callback reported plan; deny produced a matching error tool_result containing neither marker. Native and outer exit 0. Plan allow/rewrite was not tested. |

All probes used bounded requests, native output, control observations, sockets and process deadlines, and drained their owned native process groups. Parent verified final container exit without OOM and removed every owned fixture container. Earlier Darwin isolation probes aborted before native protocol execution; those remain failed prerequisites, not passing Darwin evidence.

### Initialize metadata and production streaming flag

A separate rewrite metadata probe observed `hooks_applied` present with boolean value `true` in the matching initialize response. System/init reported `claude_code_version: "2.1.240"` and tools `["Bash"]`. System/init arrived **after user input was written**, so it does not establish pre-input version validation. Response field names were retained without account/session/prompt/header values.

One further run added the production `--include-partial-messages` flag. It observed the same owned Bash tool-use ID in both a `stream_event` with `event.type: "content_block_start"` (native message 5) and `assistant.message.content` (message 7), before the matching PreToolUse callback (message 8). The callback's outer and nested tool-use IDs matched. Initialize ACK was message 1, system/init message 2; actual rewritten tool_result and native success followed. Native and outer exit were 0, no OOM, with the same isolation and cleanup. Paired provenance records the three mounted public file digests.

Production must correlate its own actual native process, ACK, observed tool-use and callback; labels or model-supplied session/prompt IDs confer no Matrix authority. Native metadata may narrow policy and cannot expand trusted admission ceilings. Unqualified hook/version contexts deny new routine actions.

## Evidence tiers and remaining gates

The isolated native probes qualify this precise Linux ARM64 protocol seam. Actual Matrix integration tests separately exercise canonical source admission, published CLI/private IPC, source HTTP, PostgreSQL receipts and canonical Bot handoff; their native/model/auth transports are named fixtures. Neither tier substitutes for a real account, other native versions/architectures, restored runtime acceptance, or combined A/B live validation.

Local detailed commands, bounded logs and inspected provenance are retained under the task research spike `claude-native-hook`, including `linux-hook-{rewrite,deny,timeout,cancel,plan-deny}.log` and `linux-hook-rewrite-partial.log` with paired provenance. They contain synthetic observations only. No unchanged probe was rerun solely to increase test counts.
