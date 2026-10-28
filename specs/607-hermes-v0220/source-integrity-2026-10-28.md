# ENG-306: source checks on copied runtime artifacts

Issue: https://linear.app/matrix-os/issue/ENG-306/upgrade-matrix-hermes-to-v0220-and-verify-native-compatibility
Draft PR: https://github.com/HamedMP/matrix-os/pull/2695

## Problem and behavior

A copied Hermes checkout can have unchanged tracked bytes but stale Git index
stat metadata. The restricted launcher used `git diff-index --quiet HEAD`, which
rejected this artifact before native launch. This was reproduced with actual
Git, and on the independently curated Linux x64 image.

Use `git diff --quiet --no-ext-diff --no-textconv HEAD --` to compare tracked
content with HEAD, including staged changes. Request no optional index locks.
The exact upstream commit pin, untracked/ignored import-code scan, source-cache
policy, disabled external diff/textconv/fsmonitor/hooks, limits and deadlines
remain in force. No flatted exception or broader import-code allowance is added.

## Verification and limits

- The new real-Git regression failed on the old check for identical copied
  bytes. Staged/unstaged modifications and ignored/untracked Python additions
  are rejected. Only the pin response in this tiny generated repository is
  substituted; every content/import scan runs real Git. Existing pin/abort
  regressions remain separate.
- Nine focused Hermes suites pass: **107 tests**. Gateway project typecheck
  passes without emitting outputs. This is not the repository-wide unit gate.
- Actual Linux artifact content comparison returns0 without changing its
  readonly index. Actual repaired compiled helper, selected PM Python and real
  OpenAI2.24.0/Anthropic0.87.0/MCP2.0.0 imports pass at4CPU, with the original
 10-second command /15-second source-check deadlines. The2CPU emulated x64
  run hit the command deadline; keep this as a resource/performance limitation,
  not native production timing qualification.
- The official PM Node26.7.0 and managed Python3.14.7 are selected from actual
  facts. Both official TUI/Web freshness readers return true; five copied
  product/receipt hashes equal the successful original compiler outputs.
- Actual production stdio client/Zod plus restricted Python arguments complete
  ready, ping, capability discovery and child cleanup. No session/prompt/model
  request is made.
- The compiled Node TUI renders the exact provider-missing Setup Required
  screen in a private PTY with an actual Python child and test-audit marker;
  Ctrl-C exits0 without forced cleanup. This is empty-profile startup only.
- Real Web lifespan enters/exits and index plus three JS assets return200.
  Strict fixture denials remain explicit: the IPv6 probe actually targets
  `::1:0` (the earlier wildcard interpretation was incorrect), passive Git
  metadata probes and chmod of fixture-owned atomic-write descriptors. No
  exception was added to suppress these denials. Web is not fully qualified.

Evidence is outside Git under
`eng306-curated-qualification-20261027/next-native-run/job-hermes-native-e06/runtime-build-20261028/`.
Keep red/green logs, receipts, provenance, PTY capture and all failures. The
repaired helper is transpiled from this source; remaining helper leaves derive
from the qualified047204Host archive. No full Host rebuild, CI, push or review
request occurs in this continuation. That earlier Host archive remains scoped
to047204, not this source change.

The curated artifact is independently assembled and explicitly omits only the
pinned non-runtime flatted Python member. The full original remains intact.
Production curation/installer integration and actual upgrade/rebuild/recovery
qualification are still pending. No installed user directory was pruned,
relocated or symlinked to bypass admission. Real-account/model/MCP host/client
acceptance, visual evidence and current-head formal CI/review remain separate.
