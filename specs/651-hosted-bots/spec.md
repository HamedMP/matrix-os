# Hosted Bots private preview

## User journey

A Matrix user opens Bots beside Chat, creates a fresh Bot, and describes its role or preferred behavior in a conversation. A subsequent conversation uses the saved behavior. Chat remains available with its existing Bots and conversations. Matrix renders the roster, creation, setup, messages, composer, model connection and loading and error states inside the OS app window.

The Bot runs on the selected Matrix Computer. A submitted run has a durable server identity. The Electron client may disconnect before the result is ready. Reopening Bots retrieves the result from the same computer. Restarting the gateway worker and rebooting the computer preserve the Bot, configuration, conversations and completed runs.

## Preview scope

OpenMausBot OSS v0.1.150 at 5491874882378603aef2536790650a192e63d56d is the product reference and the source for reusable setup and model protocol behavior. Its stock process couples execution to synchronous SQLite transcript and runtime stores. The first private preview ports the applicable behavior into Matrix owner Postgres with a separately connected provider. It does not ship the stock OpenMausBot process, recreate all upstream features or make a parity claim. The test covers creation, conversational setup and revision, chat, and durable execution. Upstream channel adapters, routines, tools and approvals, computer control and enterprise functionality require separate qualification.

Electron Desktop, Web Desktop and Web Canvas expose the same app state and operations. Mobile applicability remains to be qualified before broad availability. Production updates and old Bot or Chat data migration are outside this preview.

## Authority and durable state

| Boundary | Authority and expected behavior |
| --- | --- |
| Shell to Gateway | Matrix session and current selected owner computer. Verify authorization at each read or write. Non-private-preview computers have no Hosted Bots access. |
| Gateway to provider | Separate model credential held on the owner computer. Apply a bounded deadline. Never expose raw provider responses containing credentials or pass Matrix tokens to the provider. |
| Bot, thread and run data | Owner Postgres. A run snapshots the applicable configuration for execution. Completing the run and persisting its result are coordinated by the database. |
| Background execution | Server-side run state and lifecycle. A renderer disconnect never creates a new run or cancels the current one. Interrupted work must surface a bounded state instead of appearing to complete. |
| Existing Chat | Existing routes and stores. Hosted Bots IDs and state do not resolve in Chat. |

## Gateway contract

All paths are relative to /api/hosted-bots. There are no public routes. Each request requires the authenticated owner on the admitted Private Preview.

| Method and path | Input | Success |
| --- | --- | --- |
| GET / | None | Bot summaries |
| POST / | Bot name | Created Bot |
| GET /model | None | Connection status |
| PUT /model | Separate OpenAI API key | Connection status after validation |
| GET /:botId | Bot UUID | Saved Bot configuration and thread summaries |
| POST /:botId/threads | Optional title | Created thread |
| GET /:botId/threads/:threadId | Bot and thread UUIDs | Messages, runs and profile change history |
| POST /:botId/threads/:threadId/runs | Request UUID, mode and text | Accepted run ID and status |
| POST /:botId/profile-changes/:changeId/undo | Bot and change UUIDs, empty JSON body | Updated Bot |

Requests are bounded and validated at the gateway. A non-preview host returns 404 and an admitted host with no authorized owner returns 403. Writes have a 16 KiB body limit. Invalid fields return 400, unknown owner-scoped records return 404, conflicting writes return 409, owner limits return 429, and an unavailable dependency returns 503. Responses use no-store. Provider access is separate from the Matrix account session. The private preview reads a per-computer, owner-readable provider key file outside the shared workspace with restrictive permissions.

The gateway records a queued run before returning 202. One run may be queued or running per Bot. Retrying the same request ID and payload returns the existing run. The worker uses a fenced lease and updates completion and any proposed configuration change in one transaction. A stale profile revision prevents automatic writes. Interrupted external calls expire to a failed state. The worker never repeats a possibly billed request merely because the client disconnected.

## Hosted acceptance

1. Publish an unmerged, same-repository PR bundle using the `preview-bundle` label. Start an owner-only Private Preview for the exact published version. Verify the server installed that build. Use an Electron build from the same commit and select that exact preview Computer. [Private Preview guide](../../docs/dev/preview-environments.md#private-preview--your-own-accounts-on-a-pr).
2. Create a fresh Bot from the launcher. Configure a recognizable behavior in a conversation. In a separate thread verify that the persisted configuration affects a real reply. Change the rule or Undo and verify the difference. Test narrow and wide layouts, both themes, switching to Chat and back, and app window close and restore.
3. Enqueue one bounded real run and record its ID and submission time. Quit the entire Electron process before the run reaches completion. Observe server-side completion after quit. Reopen the same client profile and verify the result for the same run ID. Report a run that finishes too early as invalid evidence and repeat the test.
4. Record the preview machine identity and boot ID. Restart matrix-gateway and verify the saved Bot, configuration and run. Reboot that preview only. After its health returns and boot ID changes, reread the same records and verify the result is unchanged.
5. Check wrong-owner, wrong-computer and revoked access. Record build versions, hosted run and reboot evidence, and Matrix UI screenshots in the PR. A registered artifact, signed-in UI or local test fixture does not satisfy hosted acceptance.

## OpenMausBot OSS integration

The next preview retains the pinned upstream server and frontend to preserve the provider catalog and connection flows, approval decisions, routines, and desktop controls. Matrix supplies the app window, theme, and admission to the selected owner's Private Preview Computer. Matrix sign-in is the outer session. The upstream session remains separate and uses the upstream pairing mechanism.

The standalone application runs as an isolated workload on the preview. Its upstream data is owned by that preview's owner and is stored outside the Matrix synced home. Matrix records remain in owner Postgres. The initial preview's Bot records and provider credentials stay in their existing stores. The OSS runtime uses a separate workspace and credential store. Preview shutdown must preserve the workload's data, and preview teardown removes the disposable computer under the existing lifecycle.

Only an opted-in Private Preview bundle includes the workload image. The first OSS surface is Electron Desktop, where the embedded app has a dedicated origin. Web Desktop and Web Canvas retain the initial Matrix Bots surface until the upstream UI can run at a dedicated web origin. The preview installs a headless browser inside the workload; controlling a separate graphical desktop still requires an isolated upstream companion. Matrix account sign-in gates the runtime; commissioning remains separate until an owner proof can reach the code issuer without granting that privilege to other Matrix Computer processes.

| Boundary | Requirement |
| --- | --- |
| Matrix app shell to Gateway | Authenticate the Matrix owner and exact Private Preview. Check the same admission for reads, writes and any event or viewer upgrades. |
| Gateway to upstream service | Use the protected local Unix socket. Strip Matrix tokens, Matrix cookies and client-supplied identity headers. Forward only the upstream session and allowed application requests. Do not export the upstream administrative listener. |
| Pairing | A preview administrator commissions the upstream session using its private listener. Matrix still verifies the owner and exact preview before redemption through the app. Preserve expiry and one-time redemption. Do not expose code issuance or an upstream owner bypass through the Gateway. |
| Renderer | Use a separate origin and owner-scoped session. The upstream view has no Matrix preload, parent window access or shared cookie jar. Style the upstream content area with Matrix tokens. |
| Tools and schedules | Preserve upstream approval policy and schedule state. Acceptance uses a disposable workspace, one approved and one rejected harmless tool action, and one bounded scheduled run. |
| Computer | Use an isolated preview desktop or a separately paired upstream companion. Do not map the Matrix host or the user's personal desktop into the workload. Verify a harmless approved operation and show any unavailable dependency in the UI. |

Verify source licensing and absence of enterprise assets in the preview bundle. Verify the provider selector and a real provider connection, Matrix-owner admission and revocation, approval allow and deny, schedule persistence after a service restart, and approved desktop operation. Repeat the process-exit timing check for the OSS runtime. Validate each supported shell presentation separately and record which surfaces have a safe app origin and a qualified end-to-end flow. The first preview's Postgres evidence does not qualify the OSS runtime.
