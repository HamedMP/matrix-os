# Implementation plan: Figma-aligned project collaboration

**Branch:** `feat/project-sharing-figma`
**Baseline:** latest `origin/main` at worktree creation
**Status:** Implementation and verification in progress.

## Outcome

Converge the shipped owner-hosted collaboration architecture on one product boundary: projects. Preserve existing authority, direct sessions, revision checks, publication, canonical Chat history, owner-runtime execution, public Chat snapshots, and legacy standalone reads. Change only the creation boundary, project Share presentation, role labels, and the stale shared-Chat permission projection.

## Work sequence

1. Add failing contract, gateway, and UI tests for the new boundary and Figma-aligned states.
2. Change `ChatPermissionPresentation.canRequestAi` from literal `false` to `boolean` and derive it from role plus capabilities; runtime availability remains a UI gate.
3. Deny direct creation of standalone Chat, terminal, file, folder, and app scopes while preserving project and inherited Chat scope creation.
4. Remove standalone live-share creation controls. Keep public Chat snapshots and show legacy **Manage access** only when an existing standalone scope is detected.
5. Replace the project inventory/member dialog split with one Share dialog that defaults to Everyone/Editor and remains open through publication and access management.
6. Add a bounded owner-only project-access projection for immutable owner, organization access, activated members, pending direct grants, and inherited precedence.
7. Resolve the selected Clerk organization name and pass it through shared presentation components for Web Canvas, Web Desktop, and Electron Desktop.
8. Update authoritative specification and terminology without migrating wire preset `contributor`.
9. Run targeted suites, affected typechecks, React review, production builds, and Web Canvas/Electron journeys with screenshots.
10. Open the implementation PR, deferred tracking issue, and separate public documentation PR; monitor both PRs to Greptile 5/5 and green CI without merging.

## Invariants

- **Source of truth:** Clerk current membership plus Matrix project grants. Organization administration is not content authority.
- **Lock/transaction scope:** existing collaboration repositories retain revision-in-write checks and transaction ownership; the presentation endpoint is read-only.
- **Acceptable orphan states:** existing standalone scopes and grants remain valid and manageable; no cleanup or migration is inferred.
- **Auth source of truth:** gateway-local capability checks on the exact scope; client presentation never authorizes.
- **Deferred scope:** the single linked issue listed in `spec.md`; public Chat snapshots are explicitly not deferred.

## Verification matrix

| Layer | Required evidence |
| --- | --- |
| Contracts | boolean AI presentation; project-access response; unchanged `contributor` wire preset |
| Gateway | standalone creation denied; project/inherited Chat allowed; legacy standalone read/revoke; admin denied without grant; role capabilities |
| Shared UI | unified Share lifecycle; dynamic organization; general/direct precedence; activation; changes/revocation; snapshot-only Chat action; legacy manager |
| Chat | attributed human/AI layout; single queue/history; Editor composer; Viewer read-only; old/new Chat inheritance |
| Surfaces | Web Canvas, Web Desktop, Electron Desktop parity; no Mobile changes |
| Delivery | focused tests, typechecks, React checks, production builds, E2E screenshots, Greptile 5/5, green CI |
