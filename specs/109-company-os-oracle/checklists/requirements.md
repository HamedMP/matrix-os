# Specification quality checklist: Company OS and Oracle

**Canonical specification**: `specs/109-company-os-oracle/spec.md`

**Reviewed**: 2026-08-03

- [x] Product value, phases, goals, non-goals, and independently testable stories are explicit.
- [x] Functional requirements are numbered, testable, and separate alpha from later work.
- [x] Non-functional targets cover isolation, latency, revocation, recovery, scale, accessibility, and shells.
- [x] Owner, identity, runtime, resource, storage, page, whiteboard, room, and AI sources of truth are decided.
- [x] Component, request, revocation, promotion, and Oracle diagrams are included.
- [x] Authorization inheritance, explicit deny, default deny, non-enumeration, versions, cache, and admin/private boundary are defined.
- [x] Complete surface auth matrix and required validation/limits/error/cleanup posture are included.
- [x] Every required threat has prevention, detection, safe failure/recovery, and test direction.
- [x] Concurrency, partial failure, retry, compensation, cleanup, and restore behavior are specified.
- [x] Current implemented/partial/spec-only/contradicted claims cite current paths and reviewed commit.
- [x] Inaccessible dormant 081 evidence is explicitly bounded rather than invented.
- [x] Spike contains red/green evidence and executable negative/concurrency/revocation tests.
- [x] Implementation plan and small reviewable PR stack preserve personal compatibility and feature-flag rollback.
- [x] Dogfood gates prevent sensitive data before authorization, backup, export, Oracle, audit, and offboarding evidence.
- [x] Hamed decisions, experiments, deferrals, estimates, and uncertainty ranges are explicit.
- [ ] Hamed has approved implementation. This is intentionally unchecked.
