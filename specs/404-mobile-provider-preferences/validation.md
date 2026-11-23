# Validation record

Base layer: #3596, ca36b4e2fc8faf25ace316ec2e3d63053359945f.
Branch: fix/mobile-provider-native-chat-preferences. Ticket: ENG-404.

## Regression evidence

- Three initial regressions fail on original store/label code: provider access
  carryover, first-use provider isolation and Codex's native permission label.
- Replaying the original ActiveChat state against the real picker/send test fails
  on outgoing Claude effort (Medium instead of saved High). Restoring the fix
  preserves saved destination effort/access while honoring an explicit model pick.
- Existing store tests retain owner/computer isolation, serialized writes, reload,
  sign-out forgetting and save-failure behavior. The cross-provider shared-access
  expectation is replaced by independent provider assertions.
- One model/effort assertion in the full native suite required narrowing to its
  intended outcome because choices now also save the current permission mode.
  Separate permission tests retain protection of that added behavior.

## Checks

- Locked dependency install: passed; no dependency or lockfile changes.
- Initial focused run: 42/43 passed; remaining assertion updated for selected-instance
  persistence in Project Chat. Final focused check passes: 4 suites / 62 tests, including both real picker/send
  and Project Chat request boundaries, reload, first use, hydration and bounds.
  Full native Jest remains running; its earlier model-only assertion was corrected
  and passes in this final focused run.
- React Doctor changed-project audit: no issues.
- Diff pattern scan: no violations or warnings. git diff --check passes.
- Native TypeScript: default 512 MB heap OOM; larger-heap check and comparison
  against unchanged parent are pending. Existing native React/Image typings are
  documented in docs/dev/mobile-shell.md; no blanket typecheck pass is claimed.
- Required shell/gateway parity checks are running. Full workspace typecheck has
  the same missing kernel/dist prerequisite as #3596; no repeat full-workspace run.
- Native iOS/Android bundle dry run will be checked by the mobile PR workflow.

## Qualification gaps

No Native Mobile device/dev-client or reviewed live runtime was available.
Screenshots, recording and the required tech-channel evidence permalink are pending;
no surface is visually qualified. A browser render cannot qualify Native Mobile.
The separate public-docs PR in FinnaAI/matrix-os-site remains coordinated with #3596.
No model inference, production deployment, owner-runtime restart or merge.
Logs and temporary tooling artifacts stay under /tmp and can be removed after
review; fake storage lives only in tests. Temporary regression source replay was
restored in a finally block.
