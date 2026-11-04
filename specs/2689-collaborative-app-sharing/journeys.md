# Collaborative app journeys

These journeys describe colleagues using the creator's live app and existing database. Sharing starts from the app and needs no project. Publishing an app to the Gallery, installing a personal copy, and publishing a public site are separate products.

| Moment | Builder or share manager | Colleague | Expected state |
| --- | --- | --- | --- |
| Prepare | Builds an app and opens collaborative readiness. | — | Pass names the exact app version; failure names missing capabilities. |
| Share | Chooses an organization, audience, and Viewer or Editor access; reviews that existing app data will be visible. | Receives a Shared with me entry. | Access to the creator-hosted app is granted; no new data space is created. |
| Join | Opens the original app. | Accepts the share and opens that app through the owner's host. | Both see the same existing records and later changes. |
| Work | Creates or changes a task. | Sees the committed change and edits another task. | Update signals reconcile with saved records; reload shows the same result. |
| Conflict | Edits a task concurrently. | Attempts a conflicting edit. | The later writer keeps their unsaved input and can resolve the conflict. |
| Manage | Changes Viewer to Editor or revokes access. | Sees new rights or a safe access-ended state. | The service rechecks authority for every operation. |
| Host offline | The creator's runtime becomes unavailable. | Sees a safe unavailable state, then reopens when it returns. | Confirmed records persist on the creator's host. |

## Failure and recovery path

The share manager sees a readiness blocker before publishing if the app has browser-only storage, cannot support a real second user, or has not passed a two-account read and write round trip against the owner's database. A failed share leaves no discoverable half-created grant. If the owner runtime later becomes unavailable, members see a retry state and retain unsaved input. If an app version changes, Matrix checks it again before allowing new shares. Existing data stays on the owner's host.

## Product decision points

1. **Share entry — confirmed**: Share app is a direct app action. No project membership, binding, creation, or share is required.
2. **Data and host — confirmed**: The recipient uses the creator-hosted app and sees its existing database. V1 has no per-recipient record filtering or copy.
3. **Entry access — open**: Confirm whether current organization membership and the share grant are still required to open the app. This is distinct from filtering its individual records.
