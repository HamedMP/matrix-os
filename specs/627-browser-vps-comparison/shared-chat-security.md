# Shared Chrome integration boundaries

Follow-up to [MAT-6](https://linear.app/matrix-os/issue/MAT-6/add-browser-use-support-to-matrix), tracked in [#2571](https://github.com/HamedMP/matrix-os/issues/2571). MAT-6 shipped the original persistent browser; this follow-up connects personal full-access Chat runs to the visible Chrome app.

## Authentication matrix

| Route | Authority | Public |
|---|---|---|
| `POST /api/apps/browser-lab/session` | Existing exact owner authentication; issues short-lived signed app cookie | No |
| `GET /apps/browser-lab/api/browser-status` | Signed owner app cookie, origin allowlist | No |
| `POST /apps/browser-lab/api/browser-session` | Signed owner app cookie; strict body, exclusive viewer claim | No |
| `POST /apps/browser-lab/api/browser-control` | Signed owner app cookie; broker serializes owner window operations | No |
| `POST /apps/browser-lab/api/browser-automation` | Signed owner app cookie; exact server-owned principal, strict action | No |
| `POST /apps/browser-lab/api/agent-action` | Opaque expiring capability registered for exact owner/Chat/run/harness; owner cookies alone do not authorize it | No |
| Viewer HTTP/WebSocket | Existing signed viewer ticket, exact origin and app-cookie validation, bounded exclusive claim | No |
| `POST http://127.0.0.1:8730/automation-input` | Owner VPS loopback service only; fixed gateway transport, strict boolean and acknowledgement | No |
| `POST http://127.0.0.1:8730/browser-observe` | Owner VPS loopback service only; fixed gateway transport, strict surface | No |
| `/invoices` fixture subtree on port 8730 | Synthetic local test data only; never real accounts; fixed loopback fixture exception | No |
| OpenClaw `matrix.browser.bind/revoke` RPC | Native authenticated `operator.admin`; bind verifies the opaque run lease with the Matrix broker | No |

Browser input is enabled only after the driver drains/detaches and the real display gate acknowledges. A failed gate, drain or detach leaves the UI unavailable. Pause keeps the run alive for a bounded owner wait, invalidates queued actions immediately and requires a fresh snapshot after resume. Unknown action effects are never labeled as safe retries. Already-issued website actions can still finish after controller revocation.

## Network and credential limits

The agent receives fixed DOM operations and observed references, never raw CDP endpoints, arbitrary evaluation, cookies, storage, password values or credential-page content. Chrome runs in the owner's existing private profile; owner login and password-manager use stay in the visible browser. Agent-created tabs and related page/frame targets are bounded and gated; unsupported related targets require owner handoff. Existing owner tabs are not scanned or closed.

When Chrome's related-target checks cause handoff, the same run may resume that tab once and must take a fresh snapshot. If the same tab requires another related-target handoff in that run, the broker drains and detaches Chrome, releases owner input after acknowledgement, and revokes the Browser run. The tool returns a terminal failure and includes the idle state when there is no other active run. Chat agents must report verified partial progress and must not suggest Resume for that terminated run. A successful recovery returns the new snapshot without the old handoff message. Credential and download recovery retain their existing behavior. Diagnostics record only the enumerated trigger and an allowlisted target type.

Request URL validation rejects private destinations and revalidates redirects. DNS validation is a preflight, **not DNS pinning**: Chrome resolves hosts itself, so DNS rebinding remains a limitation. Related-target behavior and initial network timing need actual pinned-Chrome validation. This integration does not claim whole-profile network isolation. Full-access native harnesses remain owner-controlled runtimes, not a sandbox against a malicious local operator or modified plugin.

### Public-only browsing

When the user requests public pages only, the first action after status may be `tab_new` with `context: "public"`. The broker binds that run to the separate driver before any browser action and never falls back to the owner context. The same owner lease, input gate, and per-action approval apply. No downloads or sign-in in this mode. Ordinary browsing still uses the owner's existing profile.

The Gateway owns one isolated Chrome context and its loopback HTTPS tunnel. Chrome uses the tunnel from context creation, with the implicit loopback bypass removed and no direct fallback. The tunnel accepts only CONNECT on port 443, rejects nonpublic or mixed DNS results and connects directly to the validated IP. It has bounded connections, deadlines, and shutdown cleanup. Page/iframe Fetch rules still apply to the targets the driver configures. Only a Service Worker with the exact known public context ID can continue, without granting document or raw protocol access. An already-running iframe with the exact public context and a verified HTTPS URL can remain opaque to the driver: it receives no direct child commands or event handling and is detached through its parent. The tunnel is independent of page or action-session lifetime. Unknown targets and owner-context workers retain fail-closed behavior. This mode does not claim OS-wide network isolation.

An active semantic modal scopes the observation to its own text and controls, so background content cannot exhaust the reference budget first. Opening, replacing, or closing the modal invalidates references scoped to its previous state. Credential detection still runs before any modal observation or action. The private cursor uses fixed DOM nodes instead of an HTML string, so pages that enforce Trusted Types can still receive grounded actions without relaxing their policy.

Public tabs remain visible after the Chat ends and after the action transport reconnects. Gateway shutdown or loss of its separate owning Chrome connection disposes only the public context, which is not an authenticated-session persistence mechanism. The owner profile and its tabs remain independent. Public workflow and full/supervised acceptance require the exact installed candidate and browser surface, in addition to transport tests.

## Original document exports

Chrome native downloads retain the authenticated browser session. Each verified PDF is stored under owner-contained `data/browser-artifacts`, with original byte hash, source URL, document ID, size and retrieval time. Collection manifests export successful downloads, deduplicate by content hash and flag conflicting hashes for the same document ID. `coverage: downloads_only` expressly avoids claiming all invoices or all pagination pages were visited. Owner-reviewed workflow results record page coverage separately.

Chrome download behavior applies to the shared default browser context, not one tab. If another tab starts a download during collection, automation hands off and preserves those files in an owner recovery folder; it neither reads nor deletes their contents. At most eight recovery folders are admitted before further collection is blocked for review. Downloads and exports are bounded; temporary files have explicit cleanup and a recurring symlink-safe download sweep. Export failure preserves the original and requires owner review. A completed download without a manifest is an acceptable recoverable orphan, never evidence of a complete workflow.

## Runtime wiring and qualification

The owner-projected shared runtime injects the same broker into Browser routes, managed Matrix Pi owner tools, and initial Hermes/OpenClaw Chat adapters. Gateway shutdown closes runs and the controller before dependent services. Hermes uses a run-only native MCP configuration, preserving owner authentication. OpenClaw uses the trusted Matrix plugin, with exact native run/session/tool-call context and one-use tickets. No browser capability is admitted for supervised or restricted Jev runs.

Qualification requires real model-driven runs through each native harness, original fixture hashes, takeover/pause/resume/cancellation evidence, and live Web Canvas, Web Desktop and Electron Desktop captures. Unit fixtures and catalog discovery alone do not satisfy this gate. Native Mobile and Web Mobile currently do not expose the VPS Browser/Cloud desktop viewer; that pre-existing explicit limitation continues for this integration.
