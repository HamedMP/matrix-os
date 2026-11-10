# POC status — ENG-440

Implemented 9 November 2026. Scope: personal Claude Code/Codex telemetry, automatic discovery, Settings dashboard, and research/spec/plan for provider expansion and workflow insights.

## Working

- Web and Electron share the heatmap, totals, model ledger, filters and cost-coverage presentation.
- Web uses an exact-owner gateway API; Electron scans the OS user's standard folders over trusted main-frame IPC, with a Matrix-computer source option.
- Opening Settings discovers usage automatically; Refresh rescans. The normal flow has no file upload control.
- Source files remain unchanged. Only bounded normalized metrics reach the renderer; no provider credentials or transcript text are exported.
- Recent-first scanning, byte/file/event/depth/time budgets, duplicate handling, malformed/live-tail records and unknown-price coverage are explicit.
- Local Electron discovery and the Matrix-computer browser preview were exercised with real local histories. Captures remain outside git and are private to the requester.
- The full skills.sh snapshot contains 79 agents. Only Claude Code and Codex have POC readers.
- Paxel's public launcher was inspected; private analysis/scoring source and a reusable license were not obtained. No Paxel uploader was executed.

## Verification

- 48 focused tests pass, including both Settings navigation suites, automatic loading/refresh, scanner→parser, owner isolation, trusted IPC, stale-generation rejection and safe error handling.
- Desktop renderer/main TypeScript checks pass. Focused contracts/gateway/scanner/preview TypeScript checks pass.
- Tests demonstrated red/green accounting, cache pricing, automatic discovery and refreshed totals. One invalid-response test exposed deferred React updater validation; parsing now occurs at the async boundary.
- React Doctor was run. Its pre-existing Settings SSR/client branch finding remains present on main; no unrelated rewrite is included. Sequential filesystem traversal is intentional to keep resource budgets predictable.

## Remaining before review/merge readiness

- Current-head Greptile 5/5 and required CI.
- Reviewed staging screenshots and recordings for every affected surface, parity checks, and the Slack tech-channel evidence link. Local POC captures do not satisfy that gate.
- Full local web shell is a development preview with test auth bypass and a read-only usage backend; other runtime services are not qualified by this POC.
- A newly added gateway route is not available on an older installed Matrix runtime until a reviewed release. No production service was deployed or restarted.
- Separate public documentation PR in FinnaAI/matrix-os-site, product/design review, and native-mobile implementation/device qualification as applicable.
- Persistent owner-Postgres ingestion/backfill, additional agent readers, provider bills/quotas, and evidence-backed intelligence remain follow-on units in plan.md.

## Development

Start the loopback-only component preview with `AI_USAGE_PREVIEW_HOME=<owner-home> node --import tsx scripts/ai-usage/preview.mjs`. Use SSH forwarding for remote development; do not expose this unauthenticated developer server publicly. The production gateway route separately enforces owner authentication. Stop the task preview when review is complete. CLI metrics exports are optional troubleshooting artifacts and should be removed when no longer needed.
