# Matrix-owned Outlook

[ENG-604](https://linear.app/matrix-os/issue/ENG-604/replace-pipedream-with-matrix-owned-outlook-oauth)

## Goal

Move Matrix's Outlook Mail and Outlook Calendar connections to a Matrix-owned Microsoft Entra application and direct Microsoft Graph calls. Keep both service IDs, the current action contracts, and the approval requirements. This scope covers both work or school accounts and personal Outlook.com accounts in the public Microsoft cloud.

## User journey

A user can connect Outlook Mail or Outlook Calendar from Connect Apps, complete Microsoft consent in the browser, and return to Matrix. Settings shows the verified Microsoft account and existing account label. The selected account works in Chat, Matrix Core MCP, agents, and existing app bindings. Users can refresh or disconnect it from the same surface.

A user with a Pipedream-backed Outlook connection can reconnect it in place. The old connection stays usable until Matrix confirms that the new authorization belongs to the same Microsoft account and can perform the required actions. A cancelled, expired, failed, or wrong-account attempt preserves the existing binding. After a successful handoff, release the old Pipedream account with retryable cleanup. A user who prefers to leave can disconnect the legacy connection.

## Supported actions

| Service | Reads | Approved writes |
| --- | --- | --- |
| Outlook Mail | List messages and folders | Create a plain-text draft without recipients |
| Outlook Calendar | List calendars, list events within a date range, and read one event | Create an event without attendees |

Request delegated Microsoft scopes for the chosen service. Mail uses Mail.ReadWrite and Calendar uses Calendars.ReadWrite. Request only the identity and offline-access scopes required to recognize the account and renew its grant. Account policy can require administrator consent. Sending mail, inviting attendees, shared-mailbox actions, contacts, and webhooks for new mail or events are outside this scope.

## Authorization boundaries

| Operation | Authority and validation |
| --- | --- |
| Start consent | Authenticated Matrix owner, registered Outlook service, bounded label, optional owned connection ID, and allowlisted completion target |
| Complete consent | Public callback with single-use expiring state, browser binding, and PKCE. Use the stored owner and service. Verify Microsoft's account identity and granted scopes before persistence. Recheck account deletion admission before committing. |
| Read or refresh | Existing Matrix principal and exact owner/service/connection binding. The platform resolves the current grant and accepts only the pagination fields defined by the action schema. |
| Write | Existing action schema, owner, selected connection, required Microsoft scope, and the relevant Matrix approval. |
| Disconnect | Owner of the selected connection. Block execution and erase the Matrix token material. Handle legacy provider cleanup separately. |
| Account deletion | Existing deletion authority. Include Matrix-held Outlook tokens, consent attempts, and outstanding legacy cleanup in the deletion lifecycle. |

Platform Postgres is the source of truth for connection metadata and encrypted grant material. Bind encrypted credentials to the owner and connection. Gate callback replay, concurrent refresh, reconnect, and disconnect with conditional writes or transactions. Preserve connection IDs and owner-facing labels when switching backends. A provider switch must fail closed if the original account identity cannot be verified. Never match a legacy account by display name or a mutable email address alone.

The gateway keeps forwarding authenticated requests to the platform through the existing integration API. Platform registers the Outlook lifecycle and direct executor independently of Pipedream configuration. Resolve the connection backend when selecting the account and verify the binding again at execution. Keep production Microsoft credentials on the platform.

Bound callback query and request bodies, token responses, Graph page size and response bytes, and pending attempts per owner. Expire and sweep pending attempts. Use bounded HTTPS requests to fixed Microsoft hosts, reject redirects, and keep provider bodies and tokens out of errors and logs. Respect Graph throttling responses without automatically retrying ambiguous writes. Use the existing bounded read and refresh pagination contracts, with the owner and account checked on every page. The direct connector builds requests from its action catalog.

## Acceptance

- Web Canvas, Web Desktop, Electron Desktop, Web Mobile, and Native Mobile can complete the connection journey. Confirm both personal and managed work accounts on a reviewed preview. An admin-consent failure gives the owner a way to recover.
- Existing approved writes, read-only paths, and app bindings behave the same across the backend switch. A second Microsoft account cannot replace the selected connection. Replayed callbacks never exchange a second code.
- A revoked grant or missing scope blocks the affected actions. Successful refresh, disconnect, and account deletion leave credential and connection state consistent. Sync and legacy webhooks cannot resurrect a migrated connection.
- Matrix completes native Outlook connect, list, call, refresh, and disconnect with Pipedream unavailable. Once all legacy Outlook connections have been handled, remove Outlook imports, execution, and logo requests through Pipedream.
- Attach live captures for the affected surfaces and link the separate public documentation PR in FinnaAI/matrix-os-site.

## Rollout

1. Register a Matrix-owned Entra web application for organizational and personal Microsoft accounts. Register the exact platform callback URI and configure its client ID and pinned Secret Manager versions for the client secret and dedicated encryption key.
2. Release the compatible browser and native clients, then set `MATRIX_OUTLOOK_ENABLED=true` in a reviewed environment. Verify onboarding and Settings sign-in for both Microsoft account types, including managed-tenant consent, scoped reads, approved writes, disconnect and legacy reconnect.
3. Keep eligible legacy connections available while owners reconnect. Use the same-account check for each in-place cutover. Watch for outstanding provider cleanup before moving to retirement.
4. Set `MATRIX_OUTLOOK_LEGACY_RETIRED=true` after migration. New Outlook authorization, reads, writes and refresh then use Matrix grants. Previously linked legacy accounts can still be disconnected or reauthorized. Monitor auth failures and keep the migration journal until outstanding cleanup completes.

## Outlook Preview

Use the existing Preview Cloud Run service. Dispatch `preview-platform.yml` from the branch with the PR number, `require_existing_service=true`, and `outlook_preview=true`. The workflow deploys a tagged revision with zero traffic. For the browser test window, record the current shared Preview target, temporarily point `preview.matrix-os.com` at the PR tag, and restore the recorded target when done. Use the [Preview routing runbook](../../docs/dev/preview-environments.md#platform-preview-revisions).

The browser uses Preview's existing production Clerk configuration. For Outlook, set `OUTLOOK_PREVIEW_PR_NUMBER` and `OUTLOOK_PREVIEW_CLIENT_ID` in the GitHub Preview environment. Supply pinned version 1 of `matrix-outlook-client-secret-preview` and `matrix-outlook-credential-key-preview` through Secret Manager, with access for the Preview runtime service account. Register `https://preview.matrix-os.com/api/integrations/outlook/oauth/callback` as the Entra Web redirect URI.

Run Electron from this branch with a separate dev profile and the tagged origin for both its gateway and Platform API. Connect it to an isolated test runtime paired to the same Preview authority. The Outlook opt-in mounts only the test OAuth app and leaves legacy retirement disabled. The initial fresh-account smoke can run with Pipedream absent. Use a dedicated legacy test connection and Preview Pipedream configuration for a live migration check.

## GitHub Stack Plan

1. Specify the migration and implement the Entra OAuth transport and credential lifecycle.
2. Add durable Outlook connection storage and platform routes, including reconnect and deletion.
3. Route Outlook reads and approved writes through Graph for existing integration consumers.
4. Wire first-party consent, cleanup, and legacy retirement into the platform.
5. Finish consent and reconnect across clients and wire deployment settings for the cutover.

Review of the reconnect and enterprise consent journey by the integration owner and representative Outlook users is recommended before rollout.
