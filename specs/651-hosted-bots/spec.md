# Hosted Bots on Matrix Computers

## User journey

A Matrix user opens Bots beside Chat, creates a fresh Bot, and describes its role or preferred behavior in a conversation. A subsequent conversation uses the saved behavior. Chat remains available with its existing Bots and conversations. Matrix renders the roster, creation, setup, messages, composer, model connection and loading and error states inside the OS app window.

The Bot runs on the selected Matrix Computer. A submitted run has a durable server identity. The Electron client may disconnect before the result is ready. Reopening Bots retrieves the result from the same computer. Restarting the gateway worker and rebooting the computer preserve the Bot, configuration, conversations and completed runs.

## Initial Matrix-native preview

OpenMausBot OSS v0.1.150 at 5491874882378603aef2536790650a192e63d56d is the product reference and the source for reusable setup and model protocol behavior. Its stock process couples execution to synchronous SQLite transcript and runtime stores. The first private preview ports the applicable behavior into Matrix owner Postgres with a separately connected provider. It does not ship the stock OpenMausBot process, recreate all upstream features or make a parity claim. The test covers creation, conversational setup and revision, chat, and durable execution. Upstream channel adapters, routines, tools and approvals, computer control and enterprise functionality require separate qualification.

The original Matrix-native fallback exposes the same app state and operations on its admitted preview across Electron Desktop, Web Desktop and Web Canvas. Mobile applicability remains to be qualified before broad availability. The OSS experience below uses its own dedicated origin and separate store.

## Authority and durable state

| Boundary | Authority and expected behavior |
| --- | --- |
| Shell to Gateway | Matrix session and current selected owner computer. Verify authorization at each read or write. The legacy Matrix-native fallback uses its original Private Preview admission. |
| Gateway to provider | Separate model credential held on the owner computer. Apply a bounded deadline. Never expose raw provider responses containing credentials or pass Matrix tokens to the provider. |
| Bot, thread and run data | Owner Postgres. A run snapshots the applicable configuration for execution. Completing the run and persisting its result are coordinated by the database. |
| Background execution | Server-side run state and lifecycle. A renderer disconnect never creates a new run or cancels the current one. Interrupted work must surface a bounded state instead of appearing to complete. |
| Existing Chat | Existing routes and stores. Hosted Bots IDs and state do not resolve in Chat. |

## Gateway contract

These Matrix-native fallback paths are relative to /api/hosted-bots. There are no public routes. Each fallback request requires the authenticated owner on the admitted Private Preview. The OSS runtime has a separate gateway route under /api/hosted-bots/runtime.

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

1. Publish an unmerged, same-repository PR bundle using the `preview-bundle` label. Apply the exact registered version to the authorized Dev Computer or owner Private Preview. Verify the server installed that build. Use an Electron build from the same commit and select that exact Computer. [Private Preview guide](../../docs/dev/preview-environments.md#private-preview--your-own-accounts-on-a-pr).
2. Create a fresh Bot from the launcher. Configure a recognizable behavior in a conversation. In a separate thread verify that the persisted configuration affects a real reply. Change the rule or Undo and verify the difference. Test narrow and wide layouts, both themes, switching to Chat and back, and app window close and restore.
3. Enqueue one bounded real run and record its ID and submission time. Quit the entire Electron process before the run reaches completion. Observe server-side completion after quit. Reopen the same client profile and verify the result for the same run ID. Report a run that finishes too early as invalid evidence and repeat the test.
4. Record the test Computer identity and boot ID. Restart matrix-gateway and verify the saved Bot, configuration and run. Reboot only that test Computer. After its health returns and boot ID changes, reread the same records and verify the result is unchanged.
5. Check wrong-owner, wrong-computer and revoked access. Record build versions, hosted run and reboot evidence, and Matrix UI screenshots in the PR. A registered artifact, signed-in UI or local test fixture does not satisfy hosted acceptance.

## OpenMausBot OSS integration

The compatible Linux x64 Matrix host bundle includes the pinned OpenMausBot OSS server and frontend, its isolated container runner, and the systemd unit. The service follows the normal Gateway and bundle lifecycle on standard, Dev, and Preview Computers. It retains Bot data under /var/lib/matrix-openmausbot outside the replaceable application bundle and the Matrix synced home. The old Matrix-native Bot records and provider credentials keep their separate stores.

A root-owned image reference and archive in /opt/matrix/bin declare the installed workload. The runner requires protected regular files and an image tagged and labeled for the bundle build. Gateway health probes the running workload. The rollout can target the exact approved Dev Computer using a register-only PR bundle. Production channel promotion and fleet rollout are outside that verification.

Electron Desktop uses the trusted selected Computer handle and slot to route both HTTP and viewer upgrades over Platform. Its embedded origin and upstream session are scoped to the authenticated user and Computer. Existing paired Private Preview sessions keep their partition. Web Desktop and Web Canvas retain the Matrix-native fallback where admitted until the upstream application can run on its own web origin. Mobile remains outside the OSS surface. The container includes a headless browser, and a separate graphical desktop requires a separately isolated upstream companion.

| Boundary | Requirement |
| --- | --- |
| Matrix app shell to Gateway | Require a verified runtime bearer and the actual owner of the selected Computer for reads, writes, events and viewer upgrades. Deny another user, including a collaborator, and deny a bare machine credential or configured-owner fallback without verified user identity. |
| Gateway to upstream service | Use the protected local Unix socket. Strip Matrix tokens, Matrix cookies and client-supplied identity headers. Forward only the upstream session and allowed application requests. Do not export the upstream administrative listener. |
| Pairing | A host operator commissions the upstream session through its protected listener. Matrix verifies the owner and exact Computer before redemption through the app. Preserve expiry and one-time redemption. Do not expose code issuance or an upstream owner bypass through the Gateway. |
| Renderer | Use a separate origin and owner-scoped session. The upstream view has no Matrix preload, parent window access or shared cookie jar. Style the upstream content area with Matrix tokens. |
| Tools and schedules | Preserve upstream approval policy and schedule state. Acceptance uses a disposable workspace, one approved and one rejected harmless tool action, and one bounded scheduled run. |
| Computer | Use an isolated test desktop or a separately paired upstream companion. Do not map the Matrix host or the user's personal desktop into the workload. Verify a harmless approved operation and show any unavailable dependency in the UI. |

### Embedded appearance and connected apps

The hosted Bots view follows the effective Matrix Electron Desktop theme, including single-variant and custom palettes. The app window supplies the effective `light` or `dark` mode and bounded palette values when it opens the view and when appearance changes. Apply updates only to the dedicated `https://matrix-bots.invalid` view, keep the current conversation mounted, and apply the current palette again when the view navigates or reopens. Standalone OpenMausBot retains its own appearance controls. The hosted attachment preview uses Matrix surface, border and foreground colors in both modes. Verify both themes and the attachment preview with the same running conversation.

Connected Apps and custom MCP use upstream configuration on the selected Computer. The app catalog can render before a self-hosted Connected Apps project key is configured. Validate a connector with an approved account and a successful, scoped tool call. A separate custom MCP check can use a disposable tool that returns a synthetic value and requires no third-party account.

### Matrix AI for a direct Bots conversation

The owner-only Electron Bots app offers **Matrix AI · Text only** for direct messages using an eligible managed Matrix AI model. The picker reflects the existing Matrix provider catalog and readiness. The Gateway uses the existing App AI text completion, funded admission, Relay and usage settlement. The selected provider and its result appear in the upstream Bots conversation. This first route supports direct, unqueued text messages. Other provider connections, attachments, tools and unattended execution need their own authorization and acceptance.

| Boundary | Authorization |
| --- | --- |
| Matrix owner → `POST /api/hosted-bots/runtime/api/bots/:botId/messages` | Existing exact Computer owner admission and upstream paired session. The Gateway issues an expiring, single-use turn authorization linked to the Bot, conversation and send ID for an eligible text message. |
| Upstream provider → `GET /status`, `POST /turn` on the private model socket | Readiness projects a boolean. Inference consumes the matching turn authorization before dispatch and rechecks the selected model in the current catalog. The upstream provider receives bounded text output. |

The Gateway owns the original user text, supported model and provider credentials. The adapter includes a bounded set of direct text messages from the selected conversation branch. Saved steps, Bot memory and replayed automation context stay local to the Bots workload. The turn authorization stays in server memory and is discarded on use, expiry or Gateway shutdown. The model socket is local to the isolated Computer runtime. No Matrix or vendor credentials reach the renderer or the upstream workload. A real Computer acceptance must select Matrix AI inside Pebble, submit one identifiable test message, confirm the Relay model and usage classification, and reopen the same conversation to read the saved result. A catalog entry or local provider fixture alone does not establish live acceptance.

### Matrix-managed integration reads

**Scope.** Direct conversations with a paired user on a supported Computer with owner admission can request a registered integration read. Matrix Electron Desktop reviews each request. GitHub reads use GitHub Developer on the selected computer. Other supported apps use existing Matrix-managed Pipedream accounts under Platform's personal integration checks. Tool discovery in the upstream conversation exposes tool definitions. The Matrix review owns the connected-account list.

**Signatures.** `matrix_read_integration({service,action,params})` submits the same object to `POST /integration/read` on the protected local Unix socket. The existing `matrix_read_drive_document({fileId})` and `POST /read` keep their original interface. `GET /api/hosted-bots/integrations` returns `requests: [{id,service,action,params,expiresAt,status}]` and `accounts: [{id,service,label}]`. An explicit `?includeAccounts=1` includes accounts for the requested services. `POST /api/hosted-bots/integrations/:requestId/decision` accepts `{decision:"allow",accountId}` or `{decision:"deny"}`. `DELETE /api/hosted-bots/integrations/:requestId` cancels. The legacy `/api/hosted-bots/drive` owner interface remains scoped to legacy Drive requests.

| Boundary | Authority and behavior |
| --- | --- |
| OSS tool request | The workload submits one validated service, action, and parameter object over the read-only socket mount. The Gateway issues a fresh request ID and holds the request in memory for up to 90 seconds. The shared queue holds up to four requests. |
| Matrix review | The Computer owner reviews the exact application, action, and parameters and chooses a connected account for that service. Approval applies only to this request and lets the requesting conversation and its AI model see the result. |
| GitHub call | Gateway uses shell-free `gh` on the selected Matrix Computer, with the owner's GitHub Developer configuration and a fixed read query to `github.com`. The query returns the viewer identity alongside repository data. The Gateway checks both against the approved account and repository before releasing the result. |
| Other provider calls | The Gateway checks the registry, Platform read catalog, and active connection before dispatch. The integration client calls `/read-call` with signed owner delegation and the selected immutable connection ID. |
| Output | Generic success contains only `{data}` with a 24 KiB serialized cap. The legacy Drive result retains its file ID, optional name, and 24 KiB text cap. |
| Revocation | Cancel the pending request or abort the in-progress read and suppress its result. A completed read has consumed its approval. A later request always needs a fresh approval. |

**Validation and errors.** The generic request has a 4 KiB body limit and uses the registered action parameter definitions. Unknown fields or invalid values produce `400`, oversized requests `413`, and a full queue `429`. Unsupported or non-read actions, missing account authority, explicit denial, and expiry fail closed. Repeating an in-progress approval produces `409`. Provider failures or results larger than the output budget return a coarse error. Restarting the Gateway clears pending requests.

**Examples.** A `github.get_pr` read with `repo` set to `octocat/Hello-World` and `pullNumber` set to `1` shows those exact parameters in the review. Declining the request leaves the provider untouched. A `github.create_issue` request fails before it reaches the approval panel.

Hosted Bots supports GitHub `get_pr` and `list_prs`. The list accepts page 1, one to ten results, and `open`, `closed`, or `all`. `get_pr` includes the PR body and base and head refs. The owner review offers the local GitHub Developer identity under an ID derived from the GitHub viewer. Both actions require that identity and take the native path even when a separate Pipedream GitHub connection exists. The model receives only the approved result. The local `gh` login and SSH keys stay on the computer.

**Verification.** Test exact parameters through the socket, owner review, and the relevant native GitHub or Platform transport. Cover wrong owner, mismatched or disconnected accounts, stale approval, unsupported actions, expiry, size limits, and cancellation after dispatch. Assert that native GitHub dispatch makes zero Pipedream calls. Exercise a bounded public read through Pebble on the live test Computer and check the saved tool outcome. Repeat the existing Drive contract tests.

**Authority rule.** Bind each approval to the selected immutable connection ID. Use the native GitHub Developer query for GitHub and the dedicated `/read-call` route for Pipedream. An upstream approval, account label alone, or a model-supplied request is insufficient authority to dispatch.

### Event delivery and tool approval

The owner-scoped `GET /api/hosted-bots/runtime/api/events` bridge relays the upstream SSE cursor in `?since=` and accepts a validated `Last-Event-ID` for reconnection. Only a successful SSE response on that path disables nginx buffering and transformation. The Gateway requests identity encoding and ends a stream cleanly within 24 seconds of admission, leaving time for the deployed shared Platform's 30-second response budget. The client reconnects with its last cursor. The Electron and Platform header deadlines remain bounded and release after headers on this exact stream. Non-stream requests retain their existing timeouts.

Acceptance must cross the shared Platform timeout with a real test client before submitting an isolated, harmless browser action. For each approval, match the saved permission request and explicit user decision to the tool result. An allow case needs an independently observed browser effect with the fixture marker. A deny case needs a durable not-executed result and no matching browser effect. A request that times out does not qualify as an explicit rejection.

Verify source licensing and absence of enterprise assets in the deployed bundle. Verify the provider selector and a real provider connection, Matrix-owner admission and revocation, approval allow and deny, schedule persistence after a service restart, and approved desktop operation. Repeat the process-exit timing check for the OSS runtime. Validate each supported shell presentation separately and record which surfaces have a safe app origin and a qualified end-to-end flow. The first preview's Postgres evidence does not qualify the OSS runtime.
