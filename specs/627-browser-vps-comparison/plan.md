# Browser automation comparison on an owner-only test VPS

Status: active. User authorized test provisioning, browser installation and validation.

Compare agent-browser 0.39.0 and Browser Use 0.13.11 against one headed Google Chrome profile, streamed by KasmVNC 1.5.0. Install native host services on a disposable Matrix VPS owned by the requester with no additional access principals. Never deploy the lab to primary computers or promote a release channel. The Private Preview API currently returns unavailable; the operator preview provisioning API can explicitly set the requester as owner and an empty access list. Verify those properties before personal authentication.

## Implementation units

### U1 — Authenticated viewer and control proxy
- Goal: use the existing app-session cookie to embed full Chrome including extension windows in Web Canvas, Web Desktop and Electron Desktop.
- Files: create `packages/gateway/src/browser-lab/*.ts`, `tests/gateway/browser-lab*.test.ts`; modify `packages/gateway/src/server/app-runtime-routes.ts` only for dependency injection and registration, `packages/gateway/src/server/deferred-runtime-routes.ts` and `packages/gateway/src/server.ts` only to inject the existing WS upgrader and close lifecycle.
- Approach: optional `MATRIX_BROWSER_LAB=true` gate; mount after app-session validation and before generic app dispatch. Fixed loopback endpoints only: HTTP lab on 8730, KasmVNC 6901. Streaming proxy sanitizes paths, bounds frames, connects before accepting input, caps/evicts subscribers, closes on shutdown and expires signed sessions. No bearer or upstream credentials reach the iframe.
- Execution note: test first. Patterns: app runtime signed cookie and gateway Hono WS lifecycles.
- Test scenarios: absent/expired/wrong cookie, disabled runtime, invalid path/body/action, oversized frames, upstream unavailable, WS forwarding/reconnect and shutdown. HTTP bodyLimit, Zod strict control schemas, request deadlines and generic errors.
- Verification: focused Vitest, typecheck, live authenticated HTTP and WS path.

### U2 — Lab app and controlled automation supervisor
- Goal: Matrix app with tool selection, viewer, explicit takeover/resume/stop and a repeatable comparison fixture.
- Files: create `scripts/spikes/browser-vps/lab/**`, `scripts/spikes/browser-vps/supervisor.*`, `scripts/spikes/browser-vps/browser_use_runner.py`, `tests/spikes/browser-vps-supervisor.test.*`.
- Approach: React/Vite app installed only in test home. Backend loopback only; strict supported control operations. One automation worker at a time. Takeover terminates automation process group and closes automation connections without stopping Chrome. Resume launches fresh observation using an acknowledged checkpoint; display that this is checkpoint continuation, not guaranteed in-flight replay. Native Browser Use Agent pause/resume must be tested separately before claiming it is reliable. Use actual Browser Use actor for deterministic fixture and real Agent with a small model if owner access is available. Do not log DOM/screenshots, inputs, password-manager state or secrets. Cap/expire any ephemeral status. Preserve Chrome profile on worker restarts.
- Execution note: test first. Patterns: Vite React Matrix apps and bounded subprocess supervision.
- Test scenarios: commands rejected during takeover, late callbacks cannot change newer generation, timed-out/failed worker, shutdown/reconnect, fresh observations after resume, progress without duplicate fixture effects. Fixtures cover password and TOTP; virtual WebAuthn tests explicitly do not establish real passkeys.
- Verification: supervisor tests, UI build, real tool fixture execution on VPS.

### U3 — Provision/install/evidence
- Goal: deploy the exact lab branch via registered preview host bundle and install pinned Chrome/KasmVNC/tools as native services.
- Files: create `scripts/spikes/browser-vps/install.sh`, lab service files, `specs/627-browser-vps-comparison/results.md`; separate private site repository docs PR for any public-facing capability (lab remains test-only).
- Approach: orchestrator owns provisioning, installation, tests and git operations. Owner identity from authenticated Matrix CLI; operator secret used in memory only. Register-only bundle, explicit owner preview with empty collaborators, no fleet rollout. Chrome CDP/Kasm/backend loopback only. SSH not public test services. Install 1Password extension and leave account/device authentication to the user after viewer is ready. No vault secrets in chat. Record pass/fail/pending with evidence and versions.
- Execution note: integration spike before recommending a permanent feature.
- Test scenarios: ownership/auth denial, viewer/input in each Matrix surface, fixture password/TOTP, profile restart persistence, takeover mid-step/reconnect, real 1Password passwords/TOTP/passkeys with user, local security-key/TouchID forwarding limitations.
- Verification: health, listeners, route auth, live UI and explicit observed results. TTL 72h; document cleanup and ask whether to retain or remove after validation.

## Auth matrix and invariants

| Route | Auth | Public |
|---|---|---|
| `/apps/browser-lab/` + assets | existing owner signed app session | no |
| `/apps/browser-lab/api/status`, `/api/control` | same app session; strict operations | no |
| `/apps/browser-lab/viewer/*`, viewer WebSocket | same app session; fixed Kasm loopback | no |
| localhost fixture and supervisor | loopback bound, no platform proxy to fixture | no |

State: ephemeral supervisor checkpoint; Chrome-owned profile persists on owner VPS and is excluded from sync. No new application database. At most one worker and bounded viewer connections. Failed or interrupted work remains stopped; user must explicitly resume. The existing large gateway composition file gains only injected registration/lifecycle through small modules, with behavior extracted into dedicated lab files. Deferred: general customer browser product and real native authenticator forwarding.
