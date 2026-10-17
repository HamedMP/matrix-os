# Local validation — 17 October 2026

Branch: `codex/chat-provider-login-cache`. Fixed implementation base: `8ac1c311554eb0700032d6e5eff0f63da09f9a53`. Later `origin/main` changes are not part of this patch; a future synchronization must use rebase and appropriate revalidation.

## Result

- 15 focused Vitest files / 237 tests passed in the final combined run. All provider, login, catalog and readiness inputs were synthetic fixtures/mocks. Existing denial/failure fixtures emitted expected sanitized warnings; no unhandled test error was reported.
- TypeScript: `tsc --noEmit --incremental false` passed for `packages/gateway/tsconfig.json`, `desktop/tsconfig.json` and `shell/tsconfig.json`.
- Pattern scan: 0 violations, 3 warning groups. The repository scanner was used from a temporary copy, including desktop and working-tree changes against the fixed base. Warnings refer to existing bounded startup sets, fixed runtime paths/Promise.resolve matches, and identity fields; the new receipt set has a 64-entry FIFO cap and is cleared with the cache.
- Cached React Doctor 0.9.18 ran locally with supply-chain queries, score API, telemetry and cache disabled. Changed-scope comparison against the fixed base completed for UI, shell and desktop with zero new diagnostics. A preceding files-scope scan found 19 existing UI warnings and no errors.
- One independent local read-only reviewer found three P2 issues; all were fixed and re-reviewed with no new actionable finding. The reviewer ran no tools against providers, credentials or runtime surfaces and wrote no source.

## RED → GREEN evidence

1. The first command could not start because the shared dependency Vite config cache was outside the sandbox. The approved retry started, but 12 cases had an invalid synthetic catalog and one valid missing-notification failure. Those fixture errors were corrected before implementation; they are not product RED evidence.
2. The corrected test then produced 9 expected failing assertions for narrow suspension, ignored non-success receipts, deduplication and immediate notification. The implemented behavior passed those cases.
3. A separate actual workflow-hook test failed because its host received no receipt argument, then passed after start/resume/poll/manual-check wiring was updated.
4. ChatGPT plan IPC produced 3 expected failures before notification implementation; all 7 plan-client tests then passed, including mutation/read ordering and obsolete Computer rejection.
5. A late-request case failed before login supersession was implemented. Review then added 4 failing cases for active forced-read priority, actual cancellation UI behavior, missing source invalidation, and runtime composition. Corrections passed the final combined run. The model-cache regression uses the real in-memory Claude catalog source with synthetic discovery and proves account replacement cannot retain the old pinned model.

## Covered behavior

Already-mounted Chat consumers receive a scoped, immediate refresh after accepted success. Same-receipt duplicates do not schedule another refresh. Non-success/unknown receipts are ignored; actual login cancellation stays local, while a cancellation race returning success uses the accepted success path. User, Computer handle, runtime slot and credential generation changes fence old receipts and requests. Old catalog responses cannot overwrite the new login, even if transport ignores abort. Existing explicit Refresh/revocation behavior retains priority. Device ChatGPT plan authority changes affect its two plan route IDs, independently of native Codex and Claude.

The trusted Claude workflow invalidates only its owner's existing Claude model cache and scoped registry health before publishing success. A normal catalog projection follows; it does not force unrelated funding/system snapshots. No new periodic timer was added. Native Codex login remains capability-gated on this base, and none of the pending #2514/#2545/#2622/#2578 changes were imported.

## Remaining gates

- No successful new Linear issue receipt. Creation failed with `tool call rejected because the catalog changed after linear.save_issue was prepared`; one subsequent read-only title search returned no exact matching issue. No duplicate write was attempted. Requester assignment is unconfirmed.
- No push, PR, CI, deployment, GUI, OAuth, credential/vault read, real provider/catalog/readiness/model call, Slack post, or merge. Production builds were intentionally omitted under the task's disk/build restriction. Local tests do not qualify live visual or provider acceptance.
- The fixed base includes #2666's removal of automatic Claude review. Draft publication can still allocate hosted CI metadata and PR-title runners (`ci.yml` and `pr-title.yml`), so this task remains local under the no-CI/no-publication instruction. Recheck live workflows before any later external action.
- The separate public-site documentation PR and required live surface evidence remain pending. Recommend the affected provider/Chat owner review the exact client/runtime journey before release acceptance.

## Final test selection

`tests/desktop/{provider-catalog-login,provider-catalog-cache,provider-catalog-invalidation,chat-provider-background-cache,agents-providers-adapter,local-chatgpt-plan-client}`; `tests/ui/{provider-settings-controller,provider-workflow-login-loading,provider-workflow-terminal-restoration,local-chatgpt-subscription,provider-observation-renewal}`; `tests/gateway/{chat-runtime-catalog-wiring,provider-workflow-native,provider-workflow-registration,provider-hosted-subscription-policy}`.

Command entry: `node node_modules/vitest/vitest.mjs run ... --maxWorkers=1` with explicit file filters. Existing installed dependencies were linked locally; workspace packages resolve to this worktree, and Vite caches are local. No dependency installation or large build was needed.
