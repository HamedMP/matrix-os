# First-click project sharing and account organization selection

Tracking: [ENG-367](https://linear.app/matrix-os/issue/ENG-367/fix-first-click-project-sharing-and-restore-organization-picker), child of [ENG-29](https://linear.app/matrix-os/issue/ENG-29). Related acceptance: ENG-272 and ENG-36.

## Intended behavior

Web Desktop's menubar and Electron Desktop's compact and sidebar account menus expose the existing organization picker. Current membership and selection continue through Clerk on Web and the existing connection store on Electron. Confirmed individual accounts have no organization section. Switching keeps the menu open and announces the active selection.

A fresh private project's first Share action establishes an owner-runtime session, completes preflight, creates the private scope, reads it, configures the initial grant and reads inventory before opening the existing Share dialog. Publication still requires explicit confirmation. A failed connection must create no scope or grant and publish nothing.

## Diagnosed failure and repair

The reported installed bundle already includes private-owner routing and inherited Chat prompt-access repairs. An upgrade alone is not an established fix. Targeted gateway logs show persistent `RegistrationRejectedError`; matching Cloud Run registration requests return `POST /internal/collaboration/runtime-endpoints → 409`. The only 409 branch is `stale_generation`. Owner setup also returns `POST /api/collaboration/owner-runtime/connections → 503`. Public-safe diagnostic example: 2026-10-22 19:25:51 UTC registration 409; 17:10:44 UTC owner setup 503. Raw logs stay outside the repository.

The gateway starts at authority generation 1 after restart. A platform row advanced by control events survives the restart. Registration rejects the lower generation before the gateway can connect and learn the higher value, so retries cannot recover and control liveness expires. System-info configuration and organization identity do not prove control freshness.

Keep stale registration rejected and its transaction rolled back. Add exact-runtime generation metadata to the authenticated 409 response, after enrollment, owner, and relay-handle validation. The gateway validates that bounded response and submits the higher generation once. It installs no keys, ticket or fresh snapshot from a conflict. A second conflict, generic rejection, invalid/mismatched/non-increasing generation or shutdown fails closed. Existing backoff handles further failures. The successful registration and upgrade ticket still commit together; owner sharing still requires a live control attach.

Extract registration into a focused helper before adding behavior to the nearly 500-line control client. Preserve existing success/retry contracts and monotonic in-memory generation. No directory route, permission, audience or content authority changes are introduced. Both platform and gateway need the additive handshake; an old platform or gateway continues to fail closed on the legacy conflict response. Deployment and customer upgrade remain unauthorized.

## Security and wiring

| Boundary | Authority | Required behavior |
| --- | --- | --- |
| Organization picker | Existing Clerk membership / Electron organization listing | Presentation and selection only; server rechecks membership |
| Owner ticket | Authenticated caller, registered runtime owner, current membership, live control stream | Fail closed |
| Setup relay | Exact route/verb and runtime ownership | Private scope directory stays empty |
| Owner session | Signed ticket, possession proof, origin, freshness and runtime identity | Verify at owner gateway |
| Project grants / confirmation | Owner Postgres and revision-checked capability authority | Existing transactions and explicit publication remain unchanged |

No persistence, endpoint, timer, resource registry, or cleanup policy is introduced by reconnecting the pickers. Existing listing lifecycle releases its API when settled or closed. Existing restart, stale-response, membership reconciliation and private selection isolation remain authoritative.

## Acceptance and delivery

- Failing integration tests must reproduce actual menu omissions before reconnecting either picker.
- Exercise first-click ordering through the real direct client and relay route classifier with no private directory entry; preserve generic failures and no mutation on connection failure.
- Run focused collaboration tests, real-Postgres qualification, typecheck, pattern checks, React audit, production Web shell and Electron builds, and applicable E2E.
- Live evidence requires fresh private owner/member/outsider journeys on Web Desktop and Electron Desktop, inherited Chat prompt success, offline/restart recovery, active selection stability, screenshots and recordings from the exact PR commit. Web Canvas also uses the compact Web account menu and requires separate evidence; responsive Web Mobile applicability needs verification. Native Mobile has a separate account implementation.
- Attach captures outside the repository and share the evidence with ticket/PR links in Slack #tech only within the user's posting authorization.
- Recommend collaboration/platform and Web/Electron UI owner review. No extra stakeholder approval gate is inferred.
- Public documentation belongs in a separate `FinnaAI/matrix-os-site` PR if the diagnosed fix changes documented behavior; this regression restores existing behavior.
- Keep the PR draft until diagnosed runtime repair and required live evidence are complete. No merge or deployment is authorized.
