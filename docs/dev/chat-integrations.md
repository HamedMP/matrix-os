# Chat integration support

Settings connection state and Chat execution support are separate. An active
connection means Matrix has connection metadata; a successful provider action
still requires a runnable tool, account selection and authorization. Changing a
model or provider credential does not add missing harness tools.

| Executing route | Built-in integrations | Acceptance boundary |
| --- | --- | --- |
| Claude Code canonical Chat | Inventory, schemas, exact-account actions and account management | Run-scoped Gateway authority; action approval below |
| Claude Code Terminal | Full user-level Matrix MCP registration | Independent of Chat's strict per-run configuration |
| Codex Chat | Native MCP and read-only CLI fallback | Verify native discovery/read and fallback separately |
| Claude SDK / Matrix AI kernel | Kernel IPC tools and integration approval hook | Funding does not itself identify the executing harness |
| Hermes | Built-in MCP bootstrap and actor-scoped bearer | Custom MCP authorization is a separate contract |
| OpenClaw | Matrix MCP bootstrap registration | Verify actual runtime configuration and provider execution |
| OpenCode canonical Chat | No built-in integration bridge | Current read-only tool/permission restriction prevents fallback |
| Pi canonical Chat | No built-in integration bridge | Current read/ask_user-only route prevents fallback |
| Jev Inbox recipe | Receipt-bound preview workflow | Intentionally excludes general Drive actions |

This table records implementation/configuration paths, not a live pass for every
model, account or release. Record exact versions and actual tool outcomes when
validating a runtime.

## Claude Code authorization

New and resumed Chat runs receive a dedicated Matrix MCP configuration. It
contains built-in integration tools and Custom MCP without unrelated Chat-agent
authoring or funded Jev tools. Review runs receive metadata/schema discovery only.

Inventory and schema discovery do not fetch file/mailbox content. Provider calls
must use the exact account label from inventory. Supervised, automatic and
accept-edits runs ask through the canonical Chat approval UI for each built-in
action, including writes and account management. A browser-authenticated decision
is verified by Platform before Gateway grants one exact request. The grant binds
method, route, normalized arguments and a unique execution receipt, expires after
90 seconds, and is consumed once. The native approval response supplies the receipt
to MCP; it travels only to the local Gateway and never to Platform/provider arguments.
Cancelling a native request retracts its exact receipt even when another approved
request has identical arguments. Steering, run cancellation and completion revoke
the run capability.
Full access explicitly authorizes the fixed built-in action routes for that run;
it does not authorize other Gateway routes. Custom MCP retains its broker policy
and receipts in every mode.

Rollout requires both the Gateway host bundle and Platform's decision-verification
route. An older Platform fails closed. Integration provider credentials and the machine bearer
are never added to the Claude child environment by this integration path.

## Acceptance

Use a small synthetic fixture for automated authorization tests. On a personal
runtime, select Claude Code in Supervised mode and:

1. Discover connected integrations and preserve the selected account label.
2. Describe Google Drive's supported actions/parameters.
3. Ask to list at most three file metadata records; approve that exact action.
4. Confirm the tool completed and returned metadata. A queued or sent command
   alone is not a pass.
5. Resume the Chat and repeat a bounded read; verify fresh run authority.
6. Decline another requested action and confirm there was no provider execution.

Do not perform writes or disconnect accounts as part of a read-connectivity test.
Verify write/account-management approval with synthetic fixtures unless that
specific mutation has been authorized.

Shared PR Preview VPSes reject ordinary machine-proxied personal integrations.
The narrow Preview Drive acceptance path requires a fresh Platform-authenticated
Chat turn and a separate browser approval for one exact `google_drive.list_files`
request with an explicit account label and `maxResults` from 1 to 3. Platform
consumes a short-lived grant once and returns at most three metadata records;
the machine bearer alone cannot select a personal account. Connect, sync,
disconnect, file-content access, other services and Custom MCP remain denied.
Do not copy OAuth or model subscription credentials onto a shared VPS.

The Preview host is shared. Terminal users may inspect Chat output or runtime
state, including returned metadata. Only use the narrow real-account path when
the account owner accepts that visibility. A tagged Platform Preview backed by
staging data cannot validate an owner's production Drive connection. Record the
serving Platform revision and exact host bundle separately, then verify the
machine-only negative case before a real provider read.
