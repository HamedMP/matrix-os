# Feature Specification: Organization-Wide Project Access

**Feature Branch**: `codex/eng-29-shared-codex-subscription`
**Created**: 2026-11-04
**Status**: Draft
**Tracking**: [ENG-29](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os)
**Input**: Simplify Matrix OS V1 collaboration so sharing a project with an organization gives every current and future organization member full project work access, including shared Chats, AI, tools, terminals, and project content. The owner alone manages sharing, whole-project deletion, AI accounts and billing, and organization membership. Shared AI follows the owner's current global AI Settings with request-time verification and no fallback.

## Product Decision

Matrix OS V1 has one collaboration action and one organization-member experience:

> Sharing a project with an organization gives every active member of that organization full working access to the project.

There are no Editor or Viewer roles, direct member invitations, per-capability grants, project-level AI policies, model allowlists, provider acknowledgements, or project-to-account reconfirmation flows for new project sharing. The share action itself is the owner's acknowledgement that organization members may use the owner's currently configured AI connection for project work.

“Full working access” covers work inside the project. It does not transfer ownership or administrative authority. Only the project owner may share or unshare the project, delete the whole project, manage AI accounts or billing, or manage organization membership.

## User Scenarios & Testing

### User Story 1 - Share Once With the Organization (Priority: P1)

As a project owner, I can share a project with one organization in a single confirmation so every active organization member can immediately collaborate without configuring roles, individual grants, capabilities, or AI policy.

**Why this priority**: The feature succeeds only if project sharing becomes a single, understandable product decision.

**Independent Test**: Share an existing project containing Chats and project content, sign in as two different active organization members, and verify both can perform the same project work without additional owner setup.

**Acceptance Scenarios**:

1. **Given** a private project and an organization selected by its owner, **when** the owner confirms sharing, **then** every active organization member receives full working access to the current project contents.
2. **Given** a shared project, **when** a person becomes an active member of its organization, **then** that person receives the same project access without a new invitation or grant.
3. **Given** a shared project, **when** the owner opens its sharing controls, **then** the product shows the organization-wide access rule without role, member, capability, provider, model, or acknowledgement controls.

---

### User Story 2 - Work Freely Inside the Shared Project (Priority: P1)

As an active organization member, I can use the project's current and future Chats, content, tools, apps, and terminals so collaboration feels like joining the project rather than receiving a collection of narrow permissions.

**Why this priority**: Removing setup complexity has value only if members can complete normal project work after joining.

**Independent Test**: As a non-owner organization member, open an existing project Chat, send discussion and AI messages, create and modify project content, use an available project tool and terminal, close and reopen the project, and verify the shared state persists.

**Acceptance Scenarios**:

1. **Given** an active organization member and a shared project, **when** the member opens any existing or future project Chat, **then** the member can read history, discuss, prompt AI, and see persisted responses.
2. **Given** an active organization member and a shared project, **when** the member creates, edits, or deletes content inside the project, **then** the authorized change is visible to other project participants.
3. **Given** a project-scoped tool, app, or terminal available to the owner, **when** an active organization member uses it, **then** it operates only within the shared project boundary.
4. **Given** an active organization member, **when** the member attempts to access unrelated owner projects, owner-home data, credentials, billing settings, or organization administration, **then** access is denied.

---

### User Story 3 - Use the Owner's Current AI Connection (Priority: P1)

As an organization member working in a shared project, I can prompt AI using the project owner's current global AI configuration without asking the owner to configure a second project policy.

**Why this priority**: The reported failure is caused by duplicated provider-readiness and project-policy systems. One global source of truth removes that contradiction.

**Independent Test**: Configure the owner's global AI connection, share the project, submit a member prompt, change the owner's global connection, submit another prompt, and verify each new request uses only the connection current at its admission time.

**Acceptance Scenarios**:

1. **Given** the owner has a ready global AI connection, **when** an active organization member prompts AI in the shared project, **then** the request uses that connection without a project-level source selection or acknowledgement.
2. **Given** the owner changes the global AI connection, **when** a member starts a later request, **then** the later request uses the new current connection without project reconfirmation.
3. **Given** the owner logs out, disables AI, or has no ready connection, **when** a member attempts an AI request, **then** the request remains unavailable and does not use another provider, account, or Matrix credit.
4. **Given** the owner changes or logs out of an AI account while shared AI work is active, **when** the account change completes, **then** affected active work has stopped or drained and no later provider request can continue under stale authority.
5. **Given** a member AI prompt and a concurrent owner account change, **when** the request reaches provider admission, **then** it either uses the one verified current owner connection or makes no provider request.

---

### User Story 4 - Revoke Access With One Boundary (Priority: P2)

As a project owner or organization administrator, I can remove access through the boundary I already manage: unshare the project or remove the person from the organization.

**Why this priority**: A simple grant model requires an equally simple and reliable revocation model.

**Independent Test**: Remove a member from the organization and separately unshare a project while that member has open project and AI sessions; verify new work stops, stale sessions lose access, and the owner's private data remains unaffected.

**Acceptance Scenarios**:

1. **Given** a member with an open shared project, **when** their organization membership ends, **then** further reads, writes, AI requests, terminal input, and tool actions are denied.
2. **Given** a shared project, **when** the owner unshares it, **then** every non-owner organization member loses project access without individual grant cleanup.
3. **Given** an unshared project, **when** the owner continues working, **then** the owner's project data and history remain intact.

### Edge Cases

- Pending, invited, suspended, expired, or removed organization identities are not active members and receive no project access.
- If organization membership cannot be verified, access fails closed without exposing provider, filesystem, database, or account details.
- If the owner leaves or loses membership in the selected organization, the project stops serving organization-member access until the owner explicitly shares it with an organization they may select.
- Concurrent membership removal, unsharing, account change, or project deletion cannot admit new work after the relevant boundary changes.
- A member may delete content inside the project but cannot delete the whole project, change its sharing organization, or manage owner/provider settings.
- Existing and newly created project Chats share one canonical history; member prompts and assistant responses survive close, reload, owner-runtime restart, and reconnect without duplication.
- Legacy standalone shares remain readable and revocable under their compatibility rules, but no new standalone live share may be created.
- Public read-only Chat snapshots remain separate from live project collaboration.
- If a project capability is not installed or operational on the owner's runtime, the UI reports it unavailable; sharing does not manufacture that capability or fall back to a broader one.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST let a project owner share the whole project with exactly one organization through one explicit confirmation.
- **FR-002**: Sharing MUST grant every active current and future member of that organization the same full project working access without individual invitations, roles, grants, or capability configuration.
- **FR-003**: Full project working access MUST include current and future project Chats and history, project content, available project-scoped tools and apps, project terminals, and AI requests.
- **FR-004**: Organization-wide project access MUST NOT grant ownership or permission to share or unshare the project, delete the whole project, manage the owner's AI accounts or billing, or manage organization membership.
- **FR-005**: The project owner MUST retain uninterrupted access to the project after sharing, unsharing, organization-member revocation, or an unavailable organization-membership service.
- **FR-006**: Access MUST be derived from the project's shared organization and current active organization membership; client state, organization administration roles alone, historical invitations, and stale direct grants MUST NOT independently authorize project access.
- **FR-007**: New project sharing MUST NOT expose Editor, Viewer, direct-member, per-capability, project AI-source, model-allowlist, or provider-acknowledgement controls.
- **FR-008**: Shared-project AI requests MUST use the owner's current ready global AI connection at request admission time.
- **FR-009**: Changing the owner's global AI selection MUST apply to later shared-project requests without project-level reconfirmation.
- **FR-010**: The system MUST verify the current owner AI authority immediately before every provider request and MUST make no provider request if the authority is unavailable or changes during admission.
- **FR-011**: The system MUST NOT fall back to Matrix credit, another provider, another account, another model source, or a collaborator-supplied credential when the owner's current connection is unavailable.
- **FR-012**: Provider credentials, tokens, credential paths, billing details, and raw provider errors MUST remain unavailable to collaborators, project sandboxes, public responses, logs, and model context.
- **FR-013**: Member work MUST remain inside the shared project boundary and MUST NOT provide general access to the owner's home, unrelated projects, system configuration, or private credentials.
- **FR-014**: Unsharing or loss of active organization membership MUST deny new reads, writes, AI requests, terminal input, and tool actions and MUST stop affected active project sessions through the established revocation boundary.
- **FR-015**: Owner AI logout, account replacement, or disabling AI MUST fence new shared AI requests and stop or drain affected active work before the change becomes usable for later requests.
- **FR-016**: Shared prompts, responses, discussion, tool output, and project mutations MUST persist in the canonical project state and remain consistent after reload and reconnect.
- **FR-017**: Web Canvas, Web Desktop, and Electron Desktop MUST present the same organization-wide access rule and observable collaboration behavior.
- **FR-018**: Existing project shares MUST transition to organization-wide full working access without requiring owners to recreate projects or Chats.
- **FR-019**: Existing standalone live-share records MUST remain readable, manageable, and revocable for compatibility, while creation of new standalone live shares remains unavailable.
- **FR-020**: Failures MUST leave access no broader than before and present safe, generic recovery guidance.

### Administrative Authorization Matrix

| Operation | Project owner | Active organization member | Non-member |
| --- | --- | --- | --- |
| Read and modify project content | Yes | Yes | No |
| Use project Chats, AI, tools, apps, and terminals | Yes | Yes | No |
| Create or delete content inside the project | Yes | Yes | No |
| Share or unshare the whole project | Yes | No | No |
| Delete the whole project | Yes | No | No |
| Manage owner AI connections or billing | Yes | No | No |
| Manage organization membership | Organization policy | Organization policy | No |

### Key Entities

- **Shared Project**: A project whose owner selected one organization. It contains all current and future project content and exposes one organization-wide working-access rule.
- **Active Organization Member**: A currently verified member of the project's selected organization. Pending, expired, suspended, or removed identities are excluded.
- **Project Owner**: The immutable owner of the project and its data. The owner controls sharing, whole-project deletion, and AI/billing configuration.
- **Current AI Connection**: The one global owner-selected AI source and model configuration considered ready when a request is admitted. It is not copied into project settings.
- **Shared AI Run**: One project request attributed to the requesting member and owner, recording the actual source used for that run without establishing a durable project-to-account policy.

## Assumptions and Dependencies

- The organization's existing membership system remains authoritative for active membership.
- “Everyone in the organization” means every active member regardless of organization administration role.
- The owner accepts responsibility for usage charges when confirming organization-wide project sharing; the confirmation copy states this consequence without a separate checkbox.
- Provider Settings remains the single owner-facing place to select, change, or disconnect AI connections.
- Installed capabilities may still be unavailable for operational reasons; universal project access does not bypass runtime availability or project isolation.
- Public documentation ships in a separate `FinnaAI/matrix-os-site` pull request.
- Product, collaboration, provider-runtime, and security owners should review the authorization simplification; the requester has approved the V1 product direction.

## Explicit Exclusions

- Anonymous or public live project access.
- External guests who are not active organization members.
- Cross-organization sharing or sharing one project with multiple organizations.
- Member access to unrelated owner resources or provider credentials.
- Member control of project sharing, whole-project deletion, organization membership, provider accounts, or billing.
- New standalone live Chat, terminal, file, folder, or app shares.
- Fine-grained roles, per-member grants, per-capability controls, project-specific AI sources, and project-specific model policies.

## Success Criteria

### Measurable Outcomes

- **SC-001**: An owner can share an existing project with an organization in one confirmation and without configuring any role, member grant, capability, provider, model, or acknowledgement.
- **SC-002**: In live owner/member/outsider validation, 100% of active organization members can complete the defined project work journey and 100% of non-members are denied.
- **SC-003**: A newly activated organization member can open and use an already shared project within 10 seconds of authoritative membership becoming available, without owner action.
- **SC-004**: A removed member or member of an unshared project is denied on the next authoritative operation, with no successful new project mutation or provider request after revocation.
- **SC-005**: Across account-change, logout, unavailable-source, and concurrent-change tests, 0 provider requests use an unselected account and 0 requests fall back to another funding source.
- **SC-006**: Member prompts and AI responses remain present exactly once after project close/reopen, owner-runtime restart, and reconnect.
- **SC-007**: Web Canvas, Web Desktop, and Electron Desktop each provide live evidence of the same share, member-work, AI, persistence, and denial behavior at the exact reviewed build.
