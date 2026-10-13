# Organization collaboration on member computers

**Status:** Shipped collaboration baseline with the project-sharing alignment specified here.
**Updated:** 2026-10-07
**Design source:** Figma Desktop app, node `1433:19805` (project Share dialog). Product decisions in this specification override older frames where they differ.

## Authoritative product boundary

The project is the only boundary for creating new live collaboration. Sharing a project grants access to all current and future project-owned content, including every existing and future project Chat and its history. A project Chat is one inherited group AI timeline: attributed human prompts render on the right and assistant/tool output renders on the left. It is not copied or split into private per-member Chats.

New standalone live Chat, terminal, file, folder, and app scopes cannot be created. Existing standalone scopes, recipient links, and `Shared with me` entries remain readable for compatibility, and owners retain a legacy **Manage access** path so they can change roles or revoke access. The gateway continues to accept project scope creation and internal project-inherited child Chat scope creation.

Public read-only Chat snapshots are a separate publication feature. Snapshot creation remains available and never grants project or live-Chat access. Chat sharing offers the snapshot action only; the old live **Invite collaborators** choice is removed.

This release targets Web Canvas, Web Desktop, and Electron Desktop. It does not reorganize the topbar, organization management, or `Shared with me`; it adds no recipient file browser/editor and makes no Web Mobile or Native Mobile change.

## Roles and authority

Product copy uses exactly **Owner**, **Editor**, and **Viewer**. Stored and wire-level preset `contributor` remains unchanged and is rendered as **Editor**. No role enum, migration, or second authorization source is introduced.

- Owner is immutable and manages the project's access.
- Editor can discuss, prompt AI when the `requestAi` capability and owner runtime are available, and invoke authorized project file mutations on the owner's runtime.
- Viewer can read the shared history but cannot compose, request AI, mutate files, or operate the owner's runtime.

Clerk current organization membership plus a Matrix project grant is the sole access authority. Clerk organization owners and admins receive no implicit access to member projects. Organization administration roles never bypass a project grant.

The effective role is the strongest applicable project grant. Under organization-wide Editor access, a weaker direct Viewer grant cannot downgrade a member; the access manager presents that member as inherited Editor. Under organization-wide Viewer or Restricted access, a direct Editor grant is permitted. Revocation and role changes remain revision-checked and idempotent.

## Unified project Share dialog

Project sharing uses one Figma-aligned Share dialog for setup, publication progress, failures, retries, and ongoing access management. Separate inventory and collaborator dialogs are not product surfaces.

On the first open, the dialog:

1. Runs the existing project scope preflight and loads the revision-bound project inventory.
2. Warns that all current and future project contents share together, while files remain inside the authorization boundary and no recipient file browser/editor ships here.
3. Resolves and displays the selected Clerk organization's real display name.
4. Creates the initial general-access grant as **Everyone in {organization} · Editor** if no audience has been configured.
5. Confirms the exact inventory through the existing project-confirmation endpoint.
6. Keeps delayed publication, conflicts, retry, and success in the same dialog.

After publication, that dialog is the access manager. It shows the immutable Owner, activated members, explicit pending member grants, and general access as Editor, Viewer, or Restricted. Owners can add direct grants, change Editor/Viewer roles, and revoke grants. Organization-wide members activate access when they first open the project.

The dialog uses generic safe errors. It never exposes provider, database, filesystem, or raw gateway error details.

## Shared Chat behavior

Every project-owned Chat inherits the project's audience and effective roles, including Chats that existed before publication and Chats created later. Creation of a new project Chat must idempotently bind the inherited project scope; it must not create an independent audience.

There is one canonical timeline and one AI queue per Chat. Human prompts identify their actor and render on the right. Assistant messages, tool calls, and tool results render on the left. Realtime updates are shared by all authorized participants.

`ChatPermissionPresentation.canRequestAi` is a boolean derived from authority and availability:

- Owner or Editor + `requestAi` capability + available owner runtime: composer enabled.
- Viewer, missing capability, or unavailable runtime: history remains visible and composer is disabled with safe explanatory copy.

AI execution and project file mutations remain on the owner's runtime. This release does not add a collaborator-facing file UI.

## Compatibility and rejected concepts

- Existing scope IDs, grants, events, standalone links, and recipient entries remain valid.
- Reads, role management, and revocation remain available for existing standalone scopes.
- The standalone preflight may return an existing scope for management, but it must not issue a confirmation token for a new standalone scope.
- Direct standalone create requests fail closed at the gateway with a generic authorization response.
- Public Chat snapshots stay supported and are not live collaboration.
- The Figma concept in which each member receives a private Chat or per-member snapshot is **rejected**, not deferred. Project Chats remain shared group timelines.

## Endpoint authorization matrix

| Operation | Authentication | Required authority | Result |
| --- | --- | --- | --- |
| Project scope preflight/create | owner-runtime session | resource owner and current organization membership | allowed |
| Project inventory/confirmation/publication | owner direct session | `manage_members` on the exact project scope | revision-bound operation |
| Project grant create/change/revoke | owner direct session | `manage_members`; current scope and grant revisions | idempotent mutation |
| Project access presentation | owner direct session | `manage_members` | owner/general/activated/pending projection |
| Project-inherited Chat scope creation | internal project path | active parent project authority | allowed and audience-inherited |
| Standalone live scope create | owner-runtime session | none can authorize | denied |
| Existing standalone read/manage/revoke | direct session | existing grant/capability | compatibility path remains |
| Public Chat snapshot create/read | existing snapshot authority | snapshot rules, not collaboration grants | unchanged read-only publication |

All route parameters and bodies use bounded Zod schemas and mutating routes use body limits. Authorization is re-evaluated at the gateway; UI state is never authority. Related writes are transactional, optimistic concurrency is enforced in the write statement, and mutation retries use stable client request IDs.

## Acceptance criteria

Release evidence must prove:

- dynamic organization name and initial Everyone/Editor state;
- unified preflight, inventory conflict, publication, delayed publication, retry, and access-manager states;
- effective-role precedence, member activation, direct role changes, and revocation;
- Editor AI composition versus Viewer read-only behavior;
- attributed multi-user prompts on the right and assistant/tool output on the left;
- inheritance for existing and newly created project Chats;
- snapshot-only Chat sharing and absence of new standalone live-share controls;
- legacy standalone access management and recipient compatibility;
- gateway denial of every new standalone kind while project and inherited Chat creation still work;
- no project read from organization admin status alone;
- Editor AI/file capabilities and Viewer restrictions;
- parity on Web Canvas, Web Desktop, and Electron Desktop.

Run the focused collaboration suites, affected typechecks, React quality checks, Web and Electron production builds, and current Web Canvas/Electron end-to-end journeys with screenshots. Public documentation ships in a separate `FinnaAI/matrix-os-site` PR.

## Deferred work

Track these items in one linked GitHub issue, not an empty draft PR:

- recipient file browsing/editing and directory-to-project binding;
- closer Figma redesign and filtering of `Shared with me`;
- topbar reorganization and Notification Inbox;
- Native Mobile collaboration parity;
- standalone live Chat, terminal, file, folder, and app sharing;
- collaborative terminal UX within shared projects;
- public project links, copy-link flows, and external access requests;
- organization invite links and “join with work email”;
- fine-grained file/folder permissions and roles beyond Editor/Viewer.

Public Chat snapshots remain supported and are excluded from that deferred live-collaboration issue.
