# Dev VPS Contributor Workspaces Tasks

## Design PR

- [ ] Confirm this should be a design PR rather than a GitHub Discussion.
- [ ] Request review from @HamedMP.
- [ ] Decide local-first vs public-first default.
- [ ] Decide CLI command names and flags.
- [ ] Decide instance metadata source of truth.
- [ ] Decide public preview hostname shape.
- [ ] Decide whether terminal work belongs in this feature or a follow-up spec.

## Implementation Follow-Ups

- [ ] Add `mos dev up --path --name` repo detection and instance creation.
- [ ] Add port allocation and local forwarding.
- [ ] Add per-instance env generation outside the repo.
- [ ] Add compose project isolation.
- [ ] Add `mos dev list/open/logs/stop/rm`.
- [ ] Add `mos dev expose/unexpose` with platform-owned tunnel provisioning.
- [ ] Add authz and cleanup for public preview routes.
- [ ] Update `matrix-dev-vps` skill and contributor docs.
- [ ] Add terminal integration follow-up for TermX/WASM Ghostty/native shell access.

## Test Plan For Implementation

- [ ] Unit test repo detection.
- [ ] Unit test slug/name validation.
- [ ] Unit test port allocation and collision handling.
- [ ] Unit test instance metadata read/write and migration.
- [ ] Integration test compose env generation.
- [ ] Integration test local forwarding lifecycle.
- [ ] Integration test two concurrent dev instances.
- [ ] Security test public preview authz.
- [ ] Agent-doc test or fixture verifying preferred workflow appears in skills/docs.
