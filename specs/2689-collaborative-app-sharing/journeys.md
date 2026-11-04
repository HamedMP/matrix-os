# Collaborative app journeys

These journeys describe one live organization app instance. Sharing starts from the app and needs no project. Publishing an app to the Gallery, installing a personal copy, and publishing a public site are separate products.

| Moment | Builder or share manager | Colleague | Expected state |
| --- | --- | --- | --- |
| Prepare | Builds an app and opens collaborative readiness. | — | Pass names the exact app version; failure names missing capabilities. |
| Share | Chooses an organization, audience, and Viewer or Editor access; reviews the empty shared data space. | Receives a Shared with me entry. | One instance and one explicit access grant are created. |
| Join | Opens the shared context, separate from any personal app view. | Accepts the share and opens it. | Both see the same instance identity, data, and effective role. |
| Work | Creates or changes a task. | Sees the committed change and edits another task. | Update signals reconcile with saved records; reload shows the same result. |
| Conflict | Edits a task concurrently. | Attempts a conflicting edit. | The later writer keeps their unsaved input and can resolve the conflict. |
| Manage | Changes Viewer to Editor or revokes access. | Sees new rights or a safe access-ended state. | The service rechecks authority for every operation. |
| Depart | Leaves the organization or loses account access. | An authorized steward continues working. | The organization retains data and a usable app instance. |

## Failure and recovery path

The share manager sees a readiness blocker before publishing if the app has browser-only storage, cannot identify the current participant, cannot isolate shared data, or has not passed a real two-account round trip. A failed share leaves no discoverable half-created instance. If the runtime later becomes unavailable, members see a retry state and retain unsaved input. If an app version changes, Matrix checks it again before allowing new shares. Existing data stays recoverable.

## Product decision points

1. **Share entry — confirmed**: Share app is a direct app action. No project membership, binding, creation, or share is required.
2. **Initial data — open**: The draft assumes an empty shared instance; a later import flow may let an owner review and copy selected personal records.
3. **Ownership — open**: The draft assumes organization ownership and a steward after creator departure. This requires a durable host or transfer path beyond the current owner-hosted share.
