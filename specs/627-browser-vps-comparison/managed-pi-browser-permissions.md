# Matrix AI / Pi browser tools

Reuse [MAT-6](https://linear.app/matrix-os/issue/MAT-6/add-browser-use-support-to-matrix) and native browser stack #2689.

Matrix AI runs through the isolated Pi worker. It already has brokered integration/MCP tools and full-access shared Chrome. Add the same default-off signed browser approval path to supervised personal Pi Chats, with fresh action observations, owner takeover and no tool bypass.

## Journey and invariants

- The admitted owner/Chat/run receives `shared_browser` only when the broker and supervised approval callback are actually wired. Preserve existing full-access behavior and existing integration/MCP policies.
- The canonical orchestrator registers Pi under harness `pi`; signed choices, grant revisions, proof verification and Undo use the existing authority. No new HTTP routes, proof forms, credentials or persistence.
- The Pi worker sees bounded tool schemas and results, never the browser lease or signer/machine credentials. Browser output is untrusted.
- Freeze the browser permission mode for each admitted run. A changed mode requires a fresh run; a full-access lease cannot silently become a supervised lease without policy.
- Pause/takeover/cancellation retain broker fencing and fresh observation semantics. Run shutdown closes only its lease; existing maps/deadlines bound resources.
- Extract browser registration from the large orchestrator before extending harness handling. All surfaces consume existing canonical permission events/cards; no renderer-specific logic.

## Validation

Write failing tests for supervised admission, a real broker hold/deny/cancel flow and actual canonical signed Pi decisions/Undo, then run existing managed Pi/browser regressions. Keep local dev servers and Electron closed. Recommend engineering/product review. Record exact-source live and surface evidence separately; do not claim Electron qualification from Web Desktop.

Update the existing public browser documentation PR in FinnaAI/matrix-os-site with the tested Matrix AI/Pi behavior and remaining limits.
