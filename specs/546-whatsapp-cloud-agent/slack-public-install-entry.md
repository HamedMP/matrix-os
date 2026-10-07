# Public Slack installation entry

Slack public distribution is enabled, but its share button does not create Matrix's actor/organization-bound OAuth state. A bare share URL reaches the callback with empty state and fails authorization.

All installation CTAs point to https://app.matrix-os.com/slack/install. The entry allows sign-in without provisioning a computer, selects a Clerk organization, refreshes the user's session, and calls the existing authenticated POST installation endpoint. Only the server creates OAuth state. Before redirecting, the client validates Slack's exact consent origin/path, nonce and same-origin callback. Invalid browser callbacks drop their code and redirect to a new installation. API authorization remains unchanged.

| Route | Authentication | Public |
| --- | --- | --- |
| GET /slack/install | Human page with Clerk sign-in; no authority or mutation | Yes |
| POST /api/slack/install | Fresh Clerk actor, current organization admin, exact origin or existing cookieless Bearer policy, 256 KiB body limit | No |
| GET /api/slack/oauth/callback | Actor-bound nonce and revalidated organization admin | No; browser refresh/restart handoff only |

Web Canvas, Web Desktop, Web Mobile and Electron Desktop show the same Messaging panel and Add to Slack component. Electron opens the fixed hosted entry in the system browser. No installed or AI-ready status is inferred from a link. After installation, every employee sends connect in a private DM and links their own Matrix account. Organization channels remain an explicit administrator action.

Public website deliverable: separate site PR adds the entry component to landing, desktop download page, footer, docs sidebar and customer Slack/channel guides. Publish its buttons only after the production platform endpoint/page are live. Distribution is distinct from a Slack Marketplace listing.

Bounds: strict organization schema, no arbitrary destinations, fresh session deadline 10 seconds, installation fetch deadline 10 seconds, no-store and no-referrer, safe errors only. Account/organization changes invalidate in-flight UI results. Tests exercise authenticated install, missing session/org, forbidden/unavailable states, unsafe/stateless redirects, stalled refresh, signed-out and signed-in browser callback restarts, and Electron navigation.

Production release sequence: merge review-qualified stack and this entry, deploy platform/web and verify nonce-bearing authorization, enable event subscriptions, install in the first workspace, verify private connect/reply and shared-channel denial/approval, then deploy hosted bundles and Electron release. Existing WhatsApp Settings and Web Mobile navigation work remains separately scoped.
