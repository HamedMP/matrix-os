# Collaborative app journeys

These journeys describe colleagues using the creator's live app and existing database. Sharing starts from the app and needs no project. Publishing an app to the Gallery, installing a personal copy, and publishing a public site are separate products.

| Moment | Builder or share manager | Colleague | Expected state |
| --- | --- | --- | --- |
| Prepare | Builds an app and opens collaborative readiness. | — | Pass names the exact app version; failure names missing capabilities. |
| Share | Chooses one organization and reviews that all its current members will see existing app data and use the app. | Sees a Shared with me entry. | The organization can use the creator-hosted app; no new data space or per-person grant is created. |
| Open | Opens the original app. | Opens that app through the owner's host without an acceptance or role step. | Both see the same existing records and later changes. |
| Work | Creates or changes a task. | Sees the committed change and edits another task. | Update signals reconcile with saved records; reload shows the same result. |
| Conflict | Edits a task concurrently. | Attempts a conflicting edit. | The later writer keeps their unsaved input and can resolve the conflict. |
| Membership changes | Sees a new colleague join or an old colleague leave the organization. | Gains or loses app access with organization membership. | Every current member can use the app; former members cannot. |
| Stop sharing | Stops sharing the app with the organization. | Sees a safe access-ended state. | New app access ends while owner data remains in place. |
| Host offline | The creator's runtime becomes unavailable. | Sees a safe unavailable state, then reopens when it returns. | Confirmed records persist on the creator's host. |

## Failure and recovery path

The owner sees a technical readiness blocker before sharing if the app has browser-only storage, cannot support a real second user, or has not passed a two-account read and write round trip against the owner's database. A failed share leaves no discoverable half-created organization share. If the owner runtime later becomes unavailable, members see a retry state and retain unsaved input. If an app version changes, Matrix checks it again before allowing new shares. Existing data stays on the owner's host.

## Product decision points

1. **Share entry — confirmed**: Share app is a direct app action. No project membership, binding, creation, or share is required.
2. **Data and host — confirmed**: The recipient uses the creator-hosted app and sees its existing database. V1 has no per-recipient record filtering or copy.
3. **Access — confirmed**: Once the owner chooses the organization, every current member can use the full app. There are no further app roles, individual grants, acceptance steps, or record restrictions in V1. Membership and the active organization share still establish who can reach the owner-hosted app.
4. **Creator leaves the organization — open**: Matrix currently permits the creator to leave unless they are the final admin. Decide whether V1 requires stopping the share before departure or lets the creator keep hosting it for remaining members.
