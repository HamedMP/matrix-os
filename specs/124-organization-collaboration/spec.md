# Organization collaboration on member computers

**Status:** V1 simplification approved; detailed delivery specification in [2689 — Organization-Wide Project Access](../2689-organization-project-access/spec.md).
**Updated:** 2026-11-04
**Tracking:** [ENG-29](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os)
**Design history:** Earlier Figma role and access-management frames remain historical context. The V1 product decisions below override them where they conflict.

## Authoritative V1 product boundary

The project is the only boundary for creating new live Chat, terminal, file, and folder collaboration. Sharing a project with an organization gives every active current and future organization member full working access to all current and future project content, including Chats and history, files, apps, tools, and project terminals.

An exact app build that satisfies the collaborative-app readiness contract may also create one direct organization app scope without a project. This additive exception derives full access from current organization membership and does not reuse project roles, grants, invitations, or activation.

V1 has one organization-member experience. New project sharing has no Editor or Viewer roles, direct member invitations, per-capability grants, project-level AI policy, model allowlist, or provider acknowledgement. The owner confirms one consequence when sharing: organization members may work throughout the project and use the owner's current global AI connection.

Full working access is not ownership. Only the project owner may:

- share or unshare the whole project;
- delete the whole project; and
- manage the owner's AI connections or billing.

Organization membership remains governed by organization policy. Project ownership neither grants nor denies organization-administration authority.

Members may create, modify, and delete content inside the project. They may not access unrelated projects, the owner's general home, credentials, billing data, or system configuration.

New standalone live Chat, terminal, file, and folder scopes cannot be created. Existing standalone scopes, recipient links, and `Shared with me` entries remain readable, manageable, and revocable for compatibility. Public read-only Chat snapshots remain a separate feature and never grant live project access.

This release targets Web Canvas, Web Desktop, and Electron Desktop. Native Mobile parity remains separate.

## Authority

The authoritative access rule is:

```text
project access = project is shared with organization
                 AND actor has current active membership in that organization
```

Organization administration status does not grant access to a private project before it is shared. After sharing, every active member receives the same working access regardless of organization administration role. Pending, expired, suspended, or removed identities receive no access. When membership cannot be verified, member access fails closed.

The owner is immutable and always retains private access. Removing a member from the organization or unsharing the project ends affected member access without individual grant cleanup. If the project owner loses active membership in the selected organization, all non-owner access ends until the owner explicitly shares with an eligible organization. Revocation stops affected active project sessions and denies later operations.

## Unified Share dialog

The project Share dialog performs and explains one operation:

> Share this project with everyone in {organization}. Members can edit project content and use your configured AI connection.

Before sharing, the dialog shows the selected organization's real name and the scope of access. After sharing, it shows that the project is available to everyone in the organization and offers the owner an unshare action. It does not show roles, individual grants, capability switches, provider/model selection, or a separate AI acknowledgement.

Sharing and unsharing remain owner-authorized, revision-checked, idempotent operations. Failures use generic safe errors and never expose provider, database, filesystem, or gateway details.

## Shared Chat and AI behavior

Every project Chat inherits the project's organization access, including Chats that existed before sharing and Chats created later. There is one canonical timeline and one AI queue per Chat. Human prompts identify their actor; assistant messages, tool calls, and tool results remain shared and persistent.

AI availability is derived from membership, project authority, owner-runtime availability, and the owner's current global AI Settings:

```text
can request AI = can access shared project
                 AND owner runtime is available
                 AND owner's current AI connection is ready
```

The project does not persist a separate provider selection or long-lived project-to-account consent binding. A later owner Settings change governs later requests automatically. Each provider request must still verify the exact current owner authority at admission time. A concurrent account change either leaves the request on the one verified current authority or causes no provider request.

If the owner logs out, disables AI, changes accounts, or has no ready source, shared AI becomes unavailable. Matrix must not fall back to Matrix credit, another provider, another account, another model source, or a collaborator credential. Account changes fence new requests and stop or drain affected active work before replacement becomes usable.

Credentials remain server-side and unavailable to collaborators, sandboxes, public responses, logs, and model context. Shared execution remains constrained to the exact project boundary.

## Endpoint authorization matrix

| Operation | Authentication | Required authority | Result |
| --- | --- | --- | --- |
| Project share/unshare | Owner runtime session | project owner and current membership in selected organization | revision-bound whole-project mutation |
| Shared project read/write | Direct owner-home session | current active membership for both project owner and requesting actor in project's organization | full project working access |
| Shared Chat discussion/AI | Direct owner-home session | shared project access; AI additionally requires current ready owner connection | canonical shared timeline |
| Project tool/app/terminal use | Direct owner-home session | shared project access and operational project capability | project-scoped execution only |
| Whole-project deletion | Owner runtime session | project owner | allowed |
| Owner AI/billing mutation | Owner runtime session | owner provider authority | allowed; collaborators denied |
| Standalone live Chat/terminal/file/folder create | Owner runtime session | none can authorize | denied |
| Direct collaborative app scope create | Owner runtime session | exact app owner + current organization membership + current exact-build readiness | allowed without project/grant/activation |
| Existing standalone read/manage/revoke | Direct session | existing compatibility authority | compatibility path remains |
| Public Chat snapshot create/read | Snapshot authority | snapshot rules, not collaboration membership | unchanged read-only publication |

All route parameters and bodies use bounded Zod schemas and mutating routes use body limits. Authorization is re-evaluated at the gateway; UI state is never authority. Related writes are transactional, optimistic concurrency is enforced in the write statement, and retries use stable request identifiers.

## Compatibility and transition

- Existing shared projects transition to organization-wide full working access without project or Chat recreation.
- Historical project roles, direct grants, capability grants, and execution policies do not independently authorize or restrict V1 project access after transition.
- Existing records may be retained temporarily for rollback or audit, but current organization membership and the project's selected organization are the serving authority.
- Existing scope IDs, grants, events, standalone links, and recipient entries remain valid for compatibility.
- Reads, role management, and revocation remain available for existing standalone scopes.
- The standalone preflight may return an existing scope for management, but it must not issue a confirmation token for a new standalone scope.
- Direct standalone create requests fail closed at the gateway with a generic authorization response, except for an exact app build with a current readiness certificate under `specs/2689-collaborative-app-sharing/`.
- The app exception never changes legacy project or standalone roles. Any current organization member may share an app they own, and every current member including the organization guest role receives the app's full declared functionality without app-specific permission rows.
- Public Chat snapshots stay supported and separate from live collaboration.
- The Figma concept in which each member receives a private Chat or per-member snapshot is rejected, not deferred. Project Chats remain shared group timelines.

## Acceptance criteria

Release evidence must prove:

- one-confirmation organization sharing with no role, member, capability, provider, model, or acknowledgement setup;
- immediate equivalent access for current and newly activated organization members;
- member use of existing and future project Chats, AI, project content, tools, apps, and terminals;
- owner-only sharing, whole-project deletion, and owner AI/billing, plus organization administration governed independently by organization policy;
- member denial outside the shared project and complete outsider denial;
- automatic use of the owner's current global AI Settings for later requests;
- no provider, account, model-source, collaborator-credential, or Matrix-credit fallback;
- safe account-change, logout, unshare, membership-loss, restart, and reconnect behavior;
- canonical prompt/response persistence without duplication;
- compatibility for existing project shares and legacy standalone records;
- continued denial of new standalone Chat, terminal, file, and folder scopes while readiness-qualified direct app creation remains allowed; and
- live parity evidence for Web Canvas, Web Desktop, and Electron Desktop at the exact reviewed build.

Run focused collaboration and provider-admission suites, affected typechecks, production builds, and live owner/member/outsider journeys. Attach evidence to the PR and ENG-29, post the same evidence with the ENG-29 and PR links in Slack `#tech`, and link the Slack permalink back to the PR. Public documentation ships through a separate `FinnaAI/matrix-os-site` PR.

## Deferred work

- Anonymous, public, external-guest, cross-organization, or multi-organization live project access.
- Fine-grained roles, direct grants, per-capability controls, and project-specific AI policies.
- New standalone live Chat, terminal, file, and folder sharing, plus any app sharing that does not meet the exact-build collaborative-app contract.
- Native Mobile collaboration parity.
- Member ownership transfer, whole-project deletion, sharing administration, provider administration, or billing administration.
