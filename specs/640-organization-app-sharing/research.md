# Main baseline findings

Inspected 2026-11-04 at `0e16ddeea8`; source evidence, not deployed/runtime proof.
Fetched origin/main and safely fast-forwarded its checkout, preserving local
untracked work. The task worktree starts from that exact main commit. No pending
PR code was merged, rebased, copied, or treated as a prerequisite.

| Area | Evidence on main | Consequence |
| --- | --- | --- |
| New shares | `packages/gateway/src/collaboration/scope-routes.ts`, preflight and creation | Only project scopes can be created. Merely adding a Share button cannot enable a new app share. |
| Legacy access | `packages/ui/src/collaboration/LegacyResourceAccessButton.tsx`, `LegacyLiveAccessButton.tsx` | Existing standalone app shares can be found/managed; this is intentionally not a new-share UI. |
| Exact identity | `packages/gateway/src/collaboration/resource-catalog.ts`, `app-incarnation.ts`, `owner-app-incarnation.ts` | Reuse catalog/incarnation binding; a slug alone cannot carry authority after reinstall. |
| App operations | `packages/gateway/src/collaboration/resource-routes.ts` | Existing app description, scoped asset, view, and action routes can be extended. |
| Transactions | `packages/gateway/src/collaboration/app-instance-adapter.ts`, `project-app-adapter.ts` | Mutations already use locks/revisions, actor-scoped replay records, audit, and change notifications. |
| Data bridge | `packages/gateway/src/collaboration/scoped-app-bridge.ts` | A scoped namespace resolves to declared owner Postgres tables. Actor reaches the bridge but is not used to stamp app-level author fields. |
| Readiness | `packages/gateway/src/collaboration/resource-wiring.ts` | Registered apps are projected as `collaborationMode: scoped`. Registration is not a multi-user compatibility assessment. |
| Organization authority | `packages/platform/src/organizations/routes.ts`, `management.ts`, `clerk-resolver.ts` | Clerk-backed member/invitation/role APIs already exist; reuse them. |
| Organization UI | `shell/src/components/settings/sections/OrganizationSection.tsx`, `shell/src/components/organization/`, `desktop/src/renderer/src/features/organization/`, `packages/ui/src/organization-management/` | Shared member management is present. Audit discoverability and live behavior rather than replacing it. |
| App chrome | `shell/src/components/AppViewer.tsx`, `desktop/src/renderer/src/features/embeds/EmbedHost.tsx` | Trusted app toolbar exists for website publishing. Add private sharing separately in that host chrome. |
| Host contracts | `shell/src/lib/os-bridge.ts`, `apps/mobile/lib/app-capability-bridge.ts`, `desktop/src/main/embeds/native-app-bridge.ts` | Personal app bridges are not proof of a shared launch/identity broker. Inspect and qualify each host. |
| Skill delivery | `skills/matrix/app-builder/SKILL.md`, `scripts/sync-matrix-agent-skills.sh`, both coding-agent installers | A repository skill needs real installer discovery as well as text. Local synchronization discovers directories; remote installers have explicit lists. |

## Existing tracking

[ENG-29](https://linear.app/matrix-os/issue/ENG-29) is the active collaboration
master and is assigned to Hamed. Its recorded project-only policy matches the
source inspected here. Reuse it for this proposal rather than creating a duplicate
master. This feature intentionally proposes a qualified app-only exception.
[ENG-31](https://linear.app/matrix-os/issue/ENG-31) documents the merged resource
adapters. [ENG-273](https://linear.app/matrix-os/issue/ENG-273) documents merged
organization management. Neither ticket's completed status proves today's live
app-sharing journey.

[ENG-194](https://linear.app/matrix-os/issue/ENG-194) uses “shared app capabilities”
to mean consistent owner-approved integrations across hosts. It does not by itself
establish several people editing one app instance.

## Product recommendation

Put Share in Matrix's app window/menu, where the host knows the app identity.
Reuse that dialog from the launcher. App authors should not have to build a
sharing system into every app. Chat can open the same flow. Organization settings
manage people; the app's Manage access view manages who can use that app.

Do not auto-share a whole project to work around the creation guard. That exposes
an unrelated unit of work and contradicts the requested app-only outcome.

## Unknowns to resolve before implementation qualification

- The requester confirmed a generated app, but its slug/source/data model is
  still unknown. Inspect the selected tracker before choosing a migration or
  claiming support for its stage/comment operations.
- The runtime version and enrollment state of the owner's and recipient's
  computers are unverified. No live app, member invitation, or real recruiting
  record was modified during this investigation.
- Audit server render/asset loading, declared tables, personal KV/file dependencies,
  CSP and external services for that actual app. Do not assume a Vite build means
  it is safe to expose its assets/data to another person.
- Surface access and multi-user runtime evidence remain uncollected. Existing
  component tests or historical captures cannot close that gap.
