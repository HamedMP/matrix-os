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

## Claude 2.1.280 compatibility

This lane added `2.1.280` alongside `2.1.240`. The current exact list also includes `2.1.317`, qualified separately below; adjacent or future versions remain denied for routine calls. Unrelated Bash keeps native behavior. This compatibility check does not attest an executable or replace canonical source, exact owner action, private target, routine approval, background authorization or integration policy.

Official `@anthropic-ai/claude-code-linux-{arm64,x64}` **2.1.280** tarballs were verified against their registry SHA512 integrity before extracting the single regular executable:

| Architecture | Executable SHA256 | Qualification |
| --- | --- | --- |
| ARM64 | `92f2b4fd05d0bdcf7b9a0d4e0ecef4a1e4b368b290cd8fd07cff9a50013f45a2` | Native Linux ARM64 container |
| x64 | `1e08503dbdf3c2cb0d706d32f3408277388d1c76ef108673e8fe42c1b322925b` | Linux amd64 container under QEMU on an ARM64 Docker engine; actual x64 host execution remains distinct |

Each architecture passed six separate offline scenarios: rewrite, deny, unanswered callback, interrupt, plan deny and rewrite with production partial messages. Isolation, bounded synthetic loopback SSE, empty HOME/config and cleanup match the earlier lane. Both partial runs observed `hooks_applied: true`, system/init `2.1.280`, stream Bash tool identity before its matching callback and a subsequent actual native API `tool_result` containing only the rewritten marker. The unanswered callback actually produced correlated cancellation and an error tool result with neither marker; this is an observed result, not a universal timeout guarantee. Interrupt ended native execution with exit1/error result while the observation fixture exited0.

A second test bundles the **actual production** `createClaudeRoutineHook` and feeds it the real native frames unchanged. Its execute dependency is explicitly synthetic; an isolated dummy `matrix` prints the original marker if the literal command escapes rewriting. Before the fix, actual initialize/ACK/partial/callback and native wait0 all succeeded, but the router denied `2.1.280`, executed zero times and produced an error tool result. The intended Red is `production_router_version_gate`. After adding only the exact version alternative, native ARM64 and emulated x64 execute once, allow the safe replacement, and return a nonerror native tool result with rewritten marker only. Each run closes its server, removes owned temporary state, observes actual native close0 and leaves zero pending children; containers exit0 without OOM and are removed. This does **not** invoke the real Matrix CLI, backend or account.

The portable production-router suite separately retains `2.1.240` and covers `2.1.280` once-only behavior, cancellation, exact adjacent-version refusal, absent/negative ACK, subagent, mismatched tool identity and missing partial observation. Its initial two `2.1.280` positive tests failed on execute count0; after the predicate change all21 hook/command tests pass without skips.

## Claude 2.1.317 compatibility

Official `@anthropic-ai/claude-code-linux-{arm64,x64}` **2.1.317** tarballs were verified against their registry SHA512 integrity before extracting their single regular executable. The offline fixture selects the expected version only from its pinned artifact digest and then checks the executable's actual `--version`; there is no version override.

| Architecture | Executable SHA256 | Qualification |
| --- | --- | --- |
| ARM64 | `563a0d60ad0c223d9415768210997acb0f7134ea51dc3c238e88bc2e18ddeefa` | Native Linux ARM64 container |
| x64 | `eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0` | Linux amd64 container under QEMU on an ARM64 Docker engine; actual x64 host execution remains distinct |

Both architectures pass the same six offline native scenarios described above. The protocol fixture body is unchanged; empty HOME/config, network isolation, bounds and cleanup remain enforced. The modified artifact gate and router fixture also retain passing actual-router 2.1.280 runs on both architecture boundaries. The portable hook suite first failed only its two new 2.1.317 positive cases (19 passed, 2 failed).

The actual bundled production router also reproduces the intended Red on both architectures: matching ACK with hooks applied, system-init 2.1.317, Bash partial/tool identity and correlated callback succeed, but execution count is zero and native receives an error tool result. Adding only the exact 2.1.317 predicate alternative makes the same fixture execute once and return a nonerror native tool result containing the rewritten marker only. Actual native exit is zero; servers close, owned state is removed, pending children are zero, and containers exit zero without OOM and are removed. The focused portable hook/command suites pass all 25 cases with zero skips, including explicit rejection of adjacent 2.1.316 and 2.1.318 versions.

These are native protocol and actual-router observations with explicitly synthetic execution. A matching installed candidate digest or successful native authentication does not establish actual Chat selection, source admission, published CLI/backend integration or a real account lifecycle. Those remain separate acceptance gates.

## Reproduce the native/router boundary

The committed files under `tests/gateway/claude-routine-hook-native/` are required Linux qualification scripts, outside default portable Vitest collection. Use an independently reviewed existing Node24+ Linux image and a matching public 2.1.280 or 2.1.317 native artifact above. Set `NODE24_IMAGE` to its immutable cached image ID, `CLAUDE_PLATFORM` to `linux/arm64` or `linux/amd64`, and `CLAUDE_NATIVE` to the absolute executable path. Cross-architecture emulation must be reported explicitly.

```bash
set -eu
ROUTER_DIR="$(mktemp -d)"
trap 'rm -rf -- "$ROUTER_DIR"' EXIT
pnpm exec esbuild packages/gateway/src/chat/claude-routine-hook.ts --bundle --platform=node --format=esm --target=node24 --conditions=development --outfile="$ROUTER_DIR/router.mjs"
chmod 0644 "$ROUTER_DIR/router.mjs"
docker run --rm --pull=never --init --platform "$CLAUDE_PLATFORM" --network none \
  --user 65534:65534 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 768m --cpus 1 --pids-limit 96 --tmpfs /tmp:rw,nosuid,nodev,size=96m,mode=1777 \
  --mount "type=bind,src=$CLAUDE_NATIVE,dst=/fixture/claude,readonly" \
  --mount "type=bind,src=$PWD/tests/gateway/claude-routine-hook-native/gate.mjs,dst=/fixture/gate.mjs,readonly" \
  --mount "type=bind,src=$PWD/tests/gateway/claude-routine-hook-native/router-fixture.mjs,dst=/fixture/native-hook-fixture.mjs,readonly" \
  --mount "type=bind,src=$ROUTER_DIR/router.mjs,dst=/fixture/router.mjs,readonly" \
  "$NODE24_IMAGE" node /fixture/native-hook-fixture.mjs
```

Before running, inspect the image and mounts independently. The gate verifies Linux/architecture, nonroot identity, capability/NNP/network/rootfs conditions, exact executable digest and actual version. Missing prerequisites fail; no empty or skipped native lane counts as qualification. Retain actual structured results and container exit/OOM/cleanup evidence. Replacing the current bundle with the original exact-version predicate reproduces the intended Red without spoofing native metadata. The scripts create no credential/account, schedule, permission grant or documentation MCP service.

## Evidence tiers and remaining gates

The isolated probes qualify the precise versions and native/emulated architecture boundaries recorded above. Actual Matrix integration tests separately exercise canonical source admission, published CLI/private IPC, source HTTP, PostgreSQL receipts and canonical Bot handoff; their native/model/auth transports are named fixtures. Neither tier substitutes for a real account, unqualified versions/architectures, actual test-Computer execution, restored runtime acceptance, or combined A/B live validation.

Local detailed commands, bounded logs and inspected provenance are retained under the task research spike `claude-native-hook`, including `linux-hook-{rewrite,deny,timeout,cancel,plan-deny}.log` and `linux-hook-rewrite-partial.log` with paired provenance. They contain synthetic observations only. No unchanged probe was rerun solely to increase test counts.
