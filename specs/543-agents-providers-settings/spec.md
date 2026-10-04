# Agents & Providers Settings

Status: reconstructed implementation; final combined exact-head acceptance remains pending. Historical fixture receipts are not current acceptance.

## Product behavior

Settings presents Matrix AI first, Coding agents (Claude Code, Codex, OpenCode, Pi) second, and General agents (Hermes, OpenClaw) third. Each agent has one truthful status and an accessible accordion. Additional configured instances remain visible. Account dependencies, route selection, budgets and allowlists survive through advanced controls. The 2026-10-02 human review removes the visible Enable switch and local-login/unverified row labels; explicit successful Connect enables the exact agent, while refresh retains owner configuration.

The visual reference is [Settings canvas 1112:2178](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1112-2178). Overview, connected account and method chooser were read through Figma design context; the remaining device login, key validation, install and disconnect frames were inspected through user-authorized computer use. Sample balances, models, account identifiers, percentages and countdowns are not product data.

| Control | Authority and outcome |
| --- | --- |
| Refresh | Re-read current owner/computer capabilities and canonical provider snapshot |
| Matrix AI balance/models | Authoritative spendable ledger balance and policy-authorized display-only model inventory |
| Usage history | Bounded owner/computer ledger projection; unknown model stays unknown |
| Buy credit | Existing scoped, idempotent credit checkout; no automatic payment |
| Connect / Change account / Reconnect | Explicit supported native login or validated key submission |
| Device code / Copy / sign-in / Cancel | Foreground expiring operation; allowlisted URL and actual cancellation |
| Key Connect / retry / Back | Transient masked input; validate before saving, retain prior credential on failure |
| Install / Cancel | Fixed managed harness executable operation, real phase and canonical Terminal visibility |
| View logs | Only when advertised; bounded sanitized operation evidence, never arbitrary native output or secrets |
| Disconnect | Disable only the selected Matrix agent; preserve native credentials, other agents and owner data |
| Also uninstall | Separately authorized managed executable removal, never saved instance removal or home deletion |

## Architecture and compatibility

ProviderSettingsSnapshot and canonical V3 remain the source of provider/access truth. Shared @matrix-os/ui owns presentation derivation; Web Canvas, Web Desktop and Electron Desktop consume the same component and typed operations. Renderer adapters own navigation and abortable runtime-bound transport. New workflow and history contracts are separate from historical strict snapshots and mutation receipts; capabilities are advertised only when dependencies exist at registration.

Native credential stores remain native. Secrets do not enter snapshots, generic mutation history, public logs or durable operation receipts. No automatic account migration, reassignment, enablement or changes to immutable existing Chat bindings. Unknown allowance and installation progress are shown honestly. Subscription allowance bars show remaining capacity: 100% used is empty, 0% used is full, and partial usage subtracts from the full bar. Keep authoritative used/reset text; accessible meter names and values describe remaining allowance. Missing allowance has no meter. Related durable writes follow existing serialized revision guards or Kysely transactions; no new embedded database.

One injected native-profile guard coordinates canonical and legacy login/logout, key verification/save, and managed install/uninstall for Claude and Codex. Admission checks persisted receipts and live canonical Terminal incarnations, including receipt-evicted sessions; an expired receipt alone cannot release a live process. Exact idempotent recovery may resume its own operation. A lease releases only after confirmed exit/reaping, and ambiguous launch or failed cleanup retains protection. Direct owner Terminal commands remain outside API serialization; fresh credential fingerprints and readback establish observed current authentication mode rather than a universal filesystem lock.

Authorized workflow capabilities may expose an active operation ID for the exact harness. A fresh Settings view retrieves that scoped receipt to restore status and cancellation. Renderer GET requests have a 15-second deadline and mutations a 90-second deadline, independent of the native operation lifetime. An uncertain start retry retains its idempotency key; a lost key-save response reports uncertainty instead of claiming rejection or successful replacement.

Canonical model capabilities are returned only when the caller explicitly requests `includeModelCapabilities=true`, including action responses. Historical strict clients keep their previous model shape. Capability badges display supplied Tools, Vision, Reasoning, Long context or Audio metadata; discovered models with no authoritative capability metadata have no invented badge.

Supported native login stays in Settings: Codex device authorization, Claude browser authorization with a transient paste-code callback, Hermes explicit reuse of its runtime’s Codex account, and capability-discovered OpenCode/Pi methods, and version-gated OpenClaw OpenAI API-key entry. OpenClaw OAuth is unavailable because its verified native command requires a TTY. Native helpers save credentials through their sanctioned runtime interfaces. Unsupported installed versions expose unavailable methods. A configured connection is presented separately from execution readiness. Only a successful explicit connection enables the exact scoped route; refresh never enables it.

The native workflow has a ten-minute deadline. Hermes/OpenClaw install cancellation stops the fixed systemd cgroup, terminates the exact Terminal incarnation, then stops the cgroup again to cover startup races. The host installer has an independent upper-bound deadline. Failed cleanup keeps the operation retryable and cannot report successful cancellation. Root-owned uninstall opt-out markers prevent background sync from reinstalling an intentionally removed agent. Owner chats, projects and configuration remain intact.

### Endpoint contract

| Endpoint | Payload / result |
| --- | --- |
| `GET /api/ai/provider-settings/workflows/capabilities` | At most 32 authoritative harness capabilities |
| `POST /api/ai/provider-settings/workflows` | Strict harness ID, operation kind, supported login method and idempotency key; safe expiring receipt |
| `GET /api/ai/provider-settings/workflows/:id` | Owner-scoped operation status |
| `POST /api/ai/provider-settings/workflows/:id/code` | Owner/attempt-scoped transient Claude authorization code; bounded secret body, no receipt or diagnostic persistence |
| `POST /api/ai/provider-settings/workflows/:id/cancel` | Strict empty body; actual cleanup before cancelled receipt |
| `POST /api/ai/provider-settings/workflows/keys` | Strict bounded masked-input transport; returns only verified boolean |
| `GET /api/ai/provider-settings/workflows/logs/:harnessInstanceId` | At most 64 semantic events, with no raw native output |
| `GET /billing/ai-credit/history` | Strict runtime slot, limit 1–50 and opaque cursor; scoped signed ledger amounts |

Workflow bodies are limited to 8 KiB, operations to 64 retained entries and four queued actions, and key verification to 12 probes per minute. OpenAI verification uses the fixed non-billable models endpoint with a ten-second timeout and rejects redirects. Codex key saving runs the pinned native CLI with stdin in a disposable private staging directory; it verifies the resulting credential file and atomically renames it with mode 0600. No supplied key enters argv or durable generic mutation receipts.

## Auth matrix and limits

| Boundary | Authentication | Validation and limits |
| --- | --- | --- |
| Existing Settings reads/actions | Existing gateway owner/runtime auth | Existing revision/idempotency/body limits; native private identity/quota enrichment requires owner, collaborators receive a redacted snapshot |
| Workflow capabilities/status | Verified gateway principal matching the configured runtime owner | Fixed harness/operation IDs, bounded expiring operations, no public endpoints |
| Login/install/cancel/uninstall | Owner writable capability | bodyLimit before buffering, fixed commands/managed prefix, deadline/reaping, operation identity |
| Browser authorization code | Owner writable credential capability for the exact active attempt | Bounded transient secret input, native PKCE, single submission, no URL/receipt/log persistence |
| Key validate/save | Owner writable credential capability | Separate bounded secret payload, provider allowlist, timeout, safe errors and atomic preservation |
| Usage history | Existing platform Clerk owner auth | Resolve active owner computer from runtime slot; bounded cursor/page, Kysely owner+machine+slot predicate |
| Logs | Owner runtime/exact operation | Bounded redacted projection; no filesystem paths, raw errors or credentials |

GET responses are private/no-store. New DELETE endpoints are mutations and require bodyLimit. All external calls have timeouts. Server-generated URLs and command targets are allowlisted; no user-controlled destinations. In-memory registries have cap/TTL and shutdown cleanup. Cancellation and scope changes reject late completion; a failed cancellation cannot appear successful.

## Final presentation and compatibility

- Use shipped real OpenCode, Hermes, Pi and OpenClaw artwork; this overrides the Figma lettermarks. Resolve assets for Web VM/runtime routes and packaged Electron.
- Installed agents use Connected / Not connected from the exact configured credential/source semantics; inference readiness remains separate. Confirmed Not installed is red, while unknown installation remains Checking installation.
- Use one identically sized project chevron, natural-height/opacity disclosure motion around 200 ms, reversible interrupted transitions and reduced-motion support. Visited bodies remain mounted; collapsed controls are inert and focus returns without scrolling.
- Preserve the open agent through inventory identity reconciliation and asynchronous metadata/status updates. Runtime/owner transport changes reset private drafts, status and operation references. Connect request counters are bounded and preserve other visited rows.
- Current canonical Connected wins over historical failed/expired receipts. Active replacement Connecting remains higher priority. Change account and Disconnect are disabled during replacement; cancellation/retry remains available and settled workflows restore actions.
- No manual Enable control exists. Explicit successful Connect enables only its validated current route. Background refresh/discovery never reactivates saved Off. Compatible account/source/model/route actions and server-advertised Terminal fallback remain in collapsed Advanced configuration, without duplicate primary setup cards.
- Connected cards resolve account identity from the selected account or exact selected source; ambiguous or unrelated accounts cannot supply identity/quota. Show actual available plan/email and authoritative usage/reset. Missing usage is unavailable, not zero. Remaining rounded meters subtract used capacity from full capacity.
- Buy credit remains visible. Necessary unavailable purchase explanation belongs inside its modal, deriving only typed policy/permission/funding observations. Policy restrictions offer administrator/support guidance; refresh is useful only for unconfirmed/transient observations. This never changes purchase policy or grants credit.
- Spendable balance uses authoritative remaining microUSD, excluding reserved credit. Positive sub-cent amounts retain enough precision to avoid showing zero or rounding up to a cent. History preserves signed microUSD precision, bounded pages and opaque cursors.
- Dialog background uses system dark scrim/shadow tokens, without white glow. All button foreground/background pairs remain legible through hover/focus/active states; focus trapping and shell overlay ordering remain shared.

## Scope fences

Loaded history clears before a different loader/runtime can render. Abort and exact request/loader identity prevent late old pages or errors from entering the new dialog. Opening history retains its exact current loader. Checkout submission is scoped to source and callback identity; harmless snapshot updates preserve that callback, while real scope changes invalidate old success, failure and finally effects. No late settlement may close, unlock or mutate a new dialog.

Owner-only optional native account enrichment is negotiated separately from old strict snapshot shapes. Default, opt-out, non-owner and mutation replies omit private enrichment. Private principal proof is never serialized, logged or displayed; current native proof and coherent canonical/funding observations must agree before metadata is attached. Unknown allowance cannot fabricate subscription access. Real HTTP401 expires the Matrix session; HTTP403 owner denial preserves it.

Display-only Matrix inventory/capability badges do not establish model admission. Exact policy, funding, selected model/runtime and canonical readiness still govern execution. Matrix-owned Pi integration must preserve immutable Chat bindings and unknown-usage holds. Sonnet/GLM discovery, admission, marker replies and authoritative settlement are separate outcomes.

## Validation and delivery

Feature-layer tests cover native protocol/key failure, guard lifetime, cancellation/uninstall, owner/runtime changes, metadata privacy, checkout/history scope and grouped semantics. The final regression layer adds combined account/card/disclosure composition and synthetic Electron workflow fixtures. Computed button palette checks run in Chromium and are not native acceptance; synthetic Electron fixtures do not establish real OAuth, subscription, paid checkout or model execution.

Record exact combined source head, client app/build hashes, immutable Preview runtime identity and each actual result. Backend changes require matching Preview VPS plus Electron Desktop; frontend-only acceptance also requires Electron Desktop. Exercise Web Canvas/Web Desktop parity and record Native Mobile management as unavailable where no surface exists. New and resumed Chats retain exact bindings. Claude simulation must be labelled simulation if no subscription is available.

Historical October1 captures and validation reports refer to an older uncommitted implementation and synthetic gateway. They remain archived provenance only. New captures use a distinct output directory and cannot silently replace historical tracked screenshots. No latest combined acceptance is claimed by this spec.

Deliver bounded stacked PRs with latest-head Greptile5/5 and required CI green, plus a separate public documentation PR in the private site repository. Coordinator owns runnable Human Review and any explicitly authorized scoped deployment. This spec authorizes no new payments, grants, access changes, primary-account credential changes or fleet/channel promotion.
