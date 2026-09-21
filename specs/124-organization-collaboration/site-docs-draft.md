# Draft for `FinnaAI/matrix-os-site/content/docs/`: organization sharing

**Publication state:** local draft only. Review against the accepted S19 matrix and publish through a separate site PR after authorization. The text describes the intended V1 release and must not be presented as currently available before cutover.

## Share work inside an organization

Matrix OS organization collaboration lets a person share a project, Chat, terminal, app instance, file or folder with their current Clerk organization or with selected current members. The resource remains on the owner's computer, including files, app data, worktrees, AI execution and credentials. A recipient can open a share without owning a Matrix computer. An organization administrator does not gain content access solely from being an administrator.

The owner chooses **Viewer** or **Contributor**. Viewer can read the shared resource and observe a shared terminal. Contributor can work on the shared project, request AI where the owner's submission policy permits, and control a terminal when the owner has shared that control. A standalone file, folder, app, Chat or terminal share grants that resource only; it does not expose the enclosing project. A folder share includes its contents. Sharing outside an organization is unavailable in V1.

Organization-wide shares appear as pending to current and later members. Opening a pending share accepts it for that member. Merely seeing it does not make someone a participant. Membership changes in Clerk determine continued access; leaving or being removed ends the derived grant. Organization membership and administration stay in the Clerk dashboard.

## Group Chat and the owner's AI source

A shared project has one default group Chat for people and explicit AI requests. Joining does not make another worktree, provider account or AI source. Participants see named humans and can discuss even when AI submission is unavailable. The owner selects the project's AI source and can keep submission owner-only or, when the organization enables it, allow members to prompt that source. The source remains configured and paid for by the owner; provider terms remain the owner's responsibility. Matrix does not silently switch to a different account when a source is exhausted or offline.

A member who requests a run may cancel it and answer its tool approval. The project owner may also do so. Other Contributors and Viewers cannot decide that request. If the owner's computer loses an active run, the run becomes interrupted with the requester identified. Queued requests remain pending and are checked against current membership before resuming.

## Git identity and share inventory

Before sharing a project, the confirmation lists each Chat execution root, its branch and whether it has dirty edits. An unresolved root blocks the share. Matrix does not copy or delete a Chat's worktree when a member joins; dirty work survives Chat deletion according to the existing worktree lifecycle.

Project commits use the owner's configured Git author and committer identity. Pushes and pull requests use the owner's configured forge credential through the owner-host Git broker. The audit records the requesting member and run. V1 does not ask the owner to approve each Git operation, and it does not offer force push or remote changes as a member action. The forge credential and helper remain outside the shared execution sandbox.

## Readiness and outages

Before acceptance and the first run, Matrix shows the resource-specific readiness state: **Ready**, **Owner setup needed**, **Host offline**, or **Unsupported**. For a project, this includes the owner's AI source, submission mode, Git identity, forge credential and inventoried Chat roots. A Chat with an execution root shows the applicable source and Git information. File, folder and app shares show only setup relevant to those resources. The preview does not reveal hidden resource names to someone who lacks access.

When the owner's computer or control evidence is unavailable, collaboration fails closed. Existing data remains on the owner computer; participants cannot use a platform-side fallback to bypass its authorization. Once the computer returns, Matrix rechecks membership, grants and run state. A stopped or interrupted run is not silently replayed as another member's request.

## Availability and migration

The new organization audience, readiness and Git identity controls are part of Web Canvas, Web Desktop and Electron Desktop in V1. Native Mobile and CLI do not gain those new controls in V1; their existing shared Chat and terminal functions from the earlier release remain. There is no separate organization computer to provision for V1.

The coordinated upgrade moves collaboration to direct protocol 2 over Matrix's transparent relay. Old collaboration clients must update before opening these shares. The relay forwards direct-protocol traffic to the owner's computer and records connection metadata such as byte counts, but the owner computer decides access. If migration cannot be verified, collaboration stays unavailable until recovery or a compatible direct-protocol build is installed. A legacy authorization fallback is not restored.

## Operator notes to keep out of the public page

The public page must link to the final supported-client matrix and owner setup instructions once S19 acceptance is complete. Do not copy test credentials, customer runtime IDs, private hostnames, pricing assumptions, cutover journal internals, provider probe secrets or support incident details into the site repository. The deployment and rollback procedure belongs in the reviewed operator runbook, not in an end-user command block.
