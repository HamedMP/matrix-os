# Research: Mobile Shell

## Decision: Build on PR #99 instead of re-planning app runtime from scratch

**Rationale**: PR #99 already adds the mobile app inventory screen, native/runtime route resolution, app detail/runtime screens, WebView frame, app session token endpoint usage, and baseline app tests. The 075 plan should treat that as the existing implementation floor and focus remaining work on product behavior, terminal support, and safety hardening.

**Alternatives considered**:

- Rebuild the mobile launcher from the spec alone. Rejected because it would duplicate working PR #99 code and delay terminal/resume work.
- Merge only selected files from PR #99. Rejected because PR #99 is based on this branch's previous HEAD, is mergeable, and the mobile runtime pieces are interdependent.

## Decision: Mobile shell state stays in existing mobile storage plus owner runtime state

**Rationale**: Last active app, explicit Canvas entry, and mobile UI preferences are shell state. On-device state can use the existing mobile storage helpers for fast resume, while server-authoritative terminal sessions remain in the gateway `SessionRegistry` and owner-controlled Matrix home files.

**Alternatives considered**:

- Add a new mobile database. Rejected by the Postgres/Kysely-only rule and because the state is small.
- Store all active-app state only in the gateway. Rejected because phone resume should be fast and resilient to short offline windows, while still validating server availability when opening an app.

## Decision: Mobile Terminal reuses the gateway terminal session registry

**Rationale**: The gateway already owns durable terminal session metadata, shell process lifecycle, `/ws/terminal`, and `/api/terminal/sessions`. Mobile should expose this instead of creating a separate SSH-like path. This preserves the "no SSH keys" invariant and keeps ownership on the user's VPS.

**Alternatives considered**:

- SSH from the mobile app to the VPS. Rejected because the spec explicitly removes SSH key management from the user path.
- A separate mobile-only terminal daemon. Rejected because it would duplicate session lifecycle, auth, cleanup, and audit concerns already handled by the gateway.

## Decision: Terminal input should use a native phone control bar plus validated WebSocket frames

**Rationale**: Mobile users need Escape, Tab, arrows, Control combinations, paste, font controls, and session switching without an external keyboard. The UI can map these controls to bounded terminal WebSocket messages that reuse existing gateway validation and ownership checks.

**Alternatives considered**:

- Depend on the mobile soft keyboard alone. Rejected because common terminal keys are missing or awkward.
- Expose raw arbitrary action payloads. Rejected because the review rules require per-action payload schemas.

## Decision: Canvas remains available but explicit on phone-sized layouts

**Rationale**: Canvas is core Matrix shell behavior, but phone default should be launcher-first. Mobile should provide a clear Canvas entry point and return-to-launcher path while preserving existing desktop/tablet Canvas behavior.

**Alternatives considered**:

- Keep Canvas as the default everywhere. Rejected by the mobile spec and phone usability goals.
- Remove Canvas from mobile. Rejected because Canvas remains a first-class shell and should be available when useful.

## Decision: Harden PR #99 mobile gateway calls before building more surfaces on them

**Rationale**: `apps/mobile/lib/gateway-client.ts` is now the mobile trust boundary for app discovery, app runtime, tasks, chat, profile, and push registration. 075 tasks must add timeout wrappers, generic user-visible errors, typed response parsing where needed, and tests for failed/slow calls.

**Alternatives considered**:

- Rely on platform fetch defaults. Rejected because the Matrix review rules require finite timeouts for external calls and safe error handling.
