# Electron Desktop synthetic verification protocol

Status: new combined exact-head execution pending. No historical screenshot is presented as current acceptance.

The Electron workflow test uses a synthetic gateway, accounts, device code, key responses, ledger history and installation phases. It launches a source production Electron build in a disposable profile, suppresses external browser opening and cleans its app, sockets and profile. It cannot prove provider consent/token exchange, a real subscription, native account quota, paid checkout, package installation or VPS inference.

Fresh screenshot output uses `MATRIX_SETTINGS_EVIDENCE_DIR` when explicitly supplied; otherwise it uses a distinct temporary directory. Historical tracked image paths are never the default output. Capture paths do not prove source provenance: separately record the exact app path, source head and main/preload/renderer/CSS artifact hashes after the final parent stack is frozen.

Coordinator acceptance should verify:

- Group order, real logos, red missing-install status, one stable chevron and no Enable switch.
- First-open natural-height motion, interruption/reversal, reduced motion, inert collapsed controls and keyboard focus restoration.
- Async metadata/status changes preserve expanded agent and scroll; runtime changes clear scoped operation/draft state.
- Selected-source account details, authoritative usage/reset, rounded remaining meter, zero/full edge states and honest unavailable metadata.
- Normal Settings auth chooser, code/key masking, cancel/retry, fresh Settings recovery without duplicate login and active replacement action guards.
- Usage history pagination, current-scope privacy and late-result/error rejection; Buy credit contextual reasons and old-checkout settlement isolation.
- All visible button text/icons through hover/focus/active, system-dark modal scrim/shadow and supported advanced fallback actions.
- Exact selected-agent Disconnect confirmation preserves credentials/other agents; managed uninstall remains separate and unchecked initially.

The computed-palette E2E is a Chromium CSS harness using actual theme tokens, not Electron Desktop interaction acceptance or full accessibility certification. Its True Black thresholds and disabled-opacity limits remain explicit in the test.

After execution, append exact test counts, identifiers and sanitized artifact references. Do not transplant older hashes or QA results. Real Preview/provider/model outcomes remain separate coordinator-owned gates.
