# Spec 124 — live validation handoff

**Status as of 2026-09-24.** The implementation is merged, reviewed and green. **Zero of 26 acceptance
journeys have been run against real infrastructure.** This document exists so the live validation, the
outstanding bugs and the UI gaps can be picked up by someone who did not write the code.

It is not a status report. Every section is meant to be actionable: what to run, what to look for, what
"done" means, and what is already known to be broken so nobody spends a morning rediscovering it.

---

## 1. Where this actually stands

| Layer | State |
| --- | --- |
| Code on `main` | 35 collaboration PRs merged, tip includes S00–S20 |
| Review | every layer Greptile 5/5 at its merged head |
| Automated suites | green |
| **Live journeys** | **0 of 26** |
| Platform (`app.matrix-os.com`) | deployed 2026-09-24 11:43 (`a5adc3681`) |
| Customer VPS | **not updated** — a `main` push promotes the `dev` channel and does not touch existing VPSes |
| Coverage | gateway 73.34% stmts / 65.34% branches, kernel 61.27% / 49.44%, against a 99–100% target |

**The single blocker for any live testing**: the collaboration gateway — authority, grants, execution,
terminals — runs on the owner's VPS, not on the platform. Until a host bundle carrying this code is deployed
to a VPS, there is nothing to share. Prefer a disposable test VPS over a primary machine for the first run;
none of this code has executed outside tests.

---

## 2. Prerequisites for any live journey

These are shared by every journey below. Get them once.

1. **A VPS running a host bundle built from `main` at or after `2486bc684`.** Verify with
   `/opt/matrix/app/BUNDLE_VERSION` and `/opt/matrix/release.json`.
2. **A real Clerk organization** with at least three identities: the owner, a member, and an account that is
   **not** a member (the outsider). Several journeys are only meaningful with the third.
3. **A second Matrix computer** for the two-host journeys (2, 10, 11, 17, 25). Recipients do not need one for
   the rest — that is itself a claim worth testing.
4. **`collaboration.aiSubmission="members"`** in the organization's public metadata if members are to submit
   AI runs. Absent means owner-only, which is the default and is itself a test case (journey 9).
5. **Provider credentials** for Codex and Claude for journey 16 — the only in-scope journey that has never run
   in any form.

**Record evidence as you go.** A journey without a capture is an unevidenced journey, which is where this
release already is.

---

## 3. The 26 journeys

Status vocabulary: **AUTOMATED-ONLY** = suites pass, live half never run. **NEVER RUN** = no execution of any
kind. **LIVE** = exercised against real infrastructure; nothing holds this yet.

### 3.1 Deferred from V1 by explicit decision — do not test, do not treat as gaps

These nine were decided out of V1. They are listed so nobody mistakes a decision for an omission.

| # | Journey | Deferred to |
| --- | --- | --- |
| 3 | Peer path — B acts on A over authenticated direct HTTPS | S13 |
| 5 | Coarse roles — billing/integration manager scoping | S03 scope |
| 6 | Granular profile — Contributor limited to a selected folder/app/action | — |
| 8 | Chat disclosure — single-actor tool result cannot enter a broader Chat | — |
| 18 | Integrations — exact connection/tool/upstream delegation | S11 |
| 20 | Invite costs — no-compute/sponsor/provision choices, double-charge safety | S14 |
| 21 | Ownership — sponsoring changes payer only; org data survives departure | S14 |
| 22 | Transfer — staged inventory, checksums, crash-at-every-phase | S13 |
| 26 | Matrix groups — tokens cannot read private service rooms | S16 |

V1 tests must still assert these endpoints and selectors are **not accidentally exposed**. That assertion is
in scope even though the features are not.

### 3.2 In V1 scope — 17 journeys

---

#### 1. Org-only gate — AUTOMATED-ONLY

**Proves.** An outsider holding a valid session and direct network reachability is denied on every route,
WebSocket, queue claim, tool and integration path. No environment flag or cohort record is consulted. Missing
signing or origin configuration fails closed with a generic error. A person-to-person invitation identifier
from outside the organization does not resolve. Departure ends every derived grant.

**To run live.** Sign in as the outsider account. Attempt, in order: the scope REST routes, a direct WebSocket
upgrade, a queue claim, a tool call, an integration path. Then remove a member from the organization in the
Clerk console and confirm every grant they held stops resolving.

**Watch for.** Any response that distinguishes "exists but forbidden" from "not found" — that is an
enumeration oracle. Any error carrying a provider name, Postgres text or filesystem path.

---

#### 2. Relay transparency — AUTOMATED-ONLY

**Proves.** The client authenticates with the platform, obtains a ticket, and streams Chat/files/PTY/app
content to the owner's home **through the relay**. The relay makes no authorization decision, parses no
payload and logs none. A forged, expired or wrong-generation ticket delivered through the relay is rejected
**by the home, not by the relay**. Disabling platform-side policy storage does not affect an in-flight
session. The recipient needs no computer of their own.

**To run live.** Two enrolled computers. Capture a platform trace during a session and confirm it contains
only permitted metadata. Then: forge a ticket, replay a used one, and present one with a stale generation —
all three must be refused by the home. Finally, take platform policy storage offline mid-session and confirm
the session continues.

**This is the journey that validates the central architectural claim of the release.** If only one journey
gets run, run this one.

---

#### 4. Membership — AUTOMATED-ONLY

**Proves.** Lost and reordered webhooks, a direct Clerk console edit, and a platform/control partition all
enforce fixed deadlines. Revocation completes only after home acknowledgement or lease expiry. The same local
fence blocks REST, WS, queue and tools.

**To run live.** Edit membership directly in the Clerk console (not through the app). Drop a webhook. Deliver
two webhooks out of order. Partition the control stream past its lease during an active session. Each mode is
a separate run.

---

#### 7. Git/shell — AUTOMATED-ONLY

**Proves.** A sandboxed worker cannot reach host credentials, the forge token, `/proc` or environment secrets,
or the credential helper. Only broker operations perform Git side effects.

**To run live.** On a real systemd host, from inside the sandbox, attempt to read the forge token, the
credential helper, and host environment. Then attempt a Git side effect that does not go through the broker.

**Note.** The in-process assertions here are static. The escape attempts are the part that has never run.

---

#### 9. One owner source — AUTOMATED-ONLY

**Proves.** Multiple members share the owner's configured AI source of any kind when organization metadata
enables member submission. An organization **without** that metadata, or a project restricted to owner-only,
blocks member execution while discussion still works. Readiness shows the source kind. An owner source change
is revision-checked. An exhausted source pauses without falling back to anything else.

**To run live.** Needs a real provider source. Run with the metadata absent first (members blocked, discussion
works), then present. Change the owner source mid-flight and confirm the revision check. Exhaust the source
and confirm it pauses rather than silently switching.

**The exhaustion case is the one most likely to be wrong in production** and is proven only against fakes.

---

#### 10. Group Chat — AUTOMATED-ONLY

**Proves.** Repeated share/join produces exactly one default shared Chat and root, with named humans and an
explicit AI request. Joining creates no worktree and no account. The audience ceiling protects historical
content.

**To run live.** Two real member identities on two hosts. Share and join repeatedly; confirm one Chat, not N.

---

#### 11. Standalone shares — AUTOMATED-ONLY

**Proves.** Chat, terminal, app instance, file and folder each shared on their own grant **only that
resource**. The readiness preview shows only items applicable to the type. A terminal Viewer observes only; a
Contributor may hold the controller.

**To run live.** Share each of the five types separately, from two accounts across two hosts. For the
terminal, confirm a Viewer genuinely cannot type, then hand the controller to a Contributor and back.

---

#### 12. Explicit join — AUTOMATED-ONLY

**Proves.** An organization-wide share is pending for every current member. A member who never opens it is
**not** a participant. A member who joins the organization *after* the share exists still sees it pending.

**To run live.** Create an org-wide share. Leave one member's copy unopened for the whole test and confirm
they never appear as a participant. Add a new member to the organization afterwards and confirm the share
appears pending for them.

---

#### 13. Cancel and tool approval — AUTOMATED-ONLY

**Proves.** Only the requesting member or the project owner can cancel a run or answer its tool-approval
prompt. Other Contributors are denied and the audit names the decider.

**To run live.** Start a run as member A. Attempt to cancel as member B (must be denied), then as the owner
(must succeed). Repeat for a tool-approval prompt. Read the audit and confirm it names who decided.

---

#### 14. Home loses a run — AUTOMATED-ONLY

**Proves.** Each loss mode, exercised **separately**: restarting the gateway; killing the scope-runtime
supervisor; killing the run unit so it exits without a terminal result; partitioning the control stream past
its lease during a member's run. Every mode marks the executing run interrupted with the requester attributed,
and no other member can resubmit it. Queued requests survive and start when the home returns, each re-admitted
only on fresh membership. A queued request whose requester left the organization is dropped with notice.

**To run live.** Four separate runs, one per mode. Do not collapse them — they fail differently.

---

#### 15. Git identity — AUTOMATED-ONLY

**Proves.** A member's commit carries the configured **owner** author and committer. Their push or PR uses the
owner forge identity with no approval step. Imported history is unchanged. The audit retains the requesting
member and run. Force push and remote changes are not offered.

**To run live.** A member pushes and opens a PR on a real forge. Inspect the resulting commit authorship and
the PR author. Confirm the UI offers no force-push affordance.

---

#### 16. Shared coding — **NEVER RUN**

**Proves.** Both Codex and Claude API-backed runs operate on the project root with correct files and history,
attributed cancellation, and sandbox restrictions.

**Status.** This is the only in-scope journey with **no execution of any kind** — not even against fakes in
this configuration. It needs real Codex and Claude credentials.

**Treat this as the highest-risk unknown in the release.** Shared coding is the feature's reason to exist and
nothing has ever run it end to end.

---

#### 17. Share inventory — AUTOMATED-ONLY

**Proves.** Sharing a project whose Chats own separate worktrees lists every Chat with root, branch and dirty
state in the confirmation. An unresolvable root **blocks** the share. Joining creates no worktree. A dirty
worktree survives Chat deletion.

**To run live.** Build a project with several Chat worktrees, at least one dirty and one with an unresolvable
root. Confirm the blocked case actually blocks rather than warning.

---

#### 19. Ready-to-work — AUTOMATED-ONLY

**Proves.** Share preflight names the source kind, owner Git identity, inventoried Chat roots and missing
owner setup. No sensitive hidden-resource name enumeration.

**To run live.** Deliberately remove each prerequisite in turn — Git identity, forge credential, AI source —
and confirm preflight names the missing one without leaking names of resources the viewer may not see.

**Cannot reach LIVE while T079 is open** (see §5).

---

#### 23. Cutover — AUTOMATED-ONLY

**Proves.** IDs and old action ceilings preserved. Legacy proxy, WS and V1 paths, rollout flag and cohort
policy removed. Person-to-person records dispositioned per S20 (zero expected). Old clients are
upgrade-required. Offline or ambiguous scopes are unavailable with a recovery path. **Rollback never restores
legacy auth.**

**To run live.** An operator dry-run on a real host, including the rollback path. The rollback clause is the
one that matters: confirm a rollback cannot silently reinstate platform-side authorization.

---

#### 24. Surfaces — AUTOMATED-ONLY, **one surface known broken**

**Proves.** Web Canvas, then Web Desktop, then Electron Desktop share semantics, root, owner source and error
states using the confirmed 525 chrome.

**Status.** Native Mobile and CLI are a recorded V1 limitation — but see §4.1: Native Mobile is **known
broken**, not merely unevidenced, and the quickstart clause claiming its existing shared Chat and terminal
"keep working" has been corrected. The five shell suites that cover this row are **not surface-partitioned**:
only one of nine files is surface-specific.

**To run live.** Rendered captures on Web Canvas first, then Web Desktop, then Electron Desktop. See §5 for
the four surfaces with no capture at all, and §4.2 for the layout gap that blocks Web Desktop and Electron.

---

#### 25. Scale — AUTOMATED-ONLY

**Proves.** Control request and metadata byte rates recorded **separately** from relayed resource bytes, with
relay bandwidth cost reported. No refresh per keystroke or chunk. Bounded host connection, process and
transfer capacity, and clean shutdown.

**To run live.** Real bandwidth measurement across two hosts. The current numbers are a deterministic
in-process profile and say nothing about cost.

---

## 4. Known bugs — resolve before or during live testing

### 4.1 Native Mobile collaboration is broken — #1881

**Not unevidenced. Broken, provably.**

- `packages/platform/src/platform-websocket-upgrade.ts` destroys any `/ws/collaboration/` upgrade that
  `parseRelaySocketPath` refuses.
- That regex requires a `/direct/` segment:
  `^/ws/collaboration/direct/scopes/(<uuid>)/(events|terminal)$` (`collaboration/relay.ts`).
- `apps/mobile/lib/requests/collaboration.ts` builds `/ws/collaboration/scopes/<id>/events` and `/terminal` —
  no `/direct/`.
- Its tests pass because they assert **the URL the client builds**, never the server's acceptance.

Four boundary-blind assertions sit in `apps/mobile/__tests__/requests-collaboration.test.ts`: two on the
retired `connection-tickets` POST, two on the socket URLs. The socket pair is the stronger evidence — it pins,
as a requirement, the exact string the server exists to reject.

**Fix**: migrate Native Mobile onto the direct endpoints, and replace the client-output assertions with ones
that observe acceptance.

### 4.2 Web Desktop and Electron Desktop cannot reach the share control — #1798

The capability is wired but unreachable on two of the three default surfaces.

- `DesktopWindow` passes `desktopParity` to the Terminal app, which renders `DesktopTerminalSidebar` (no
  project groups → no `ProjectSharing` row) and `DesktopTerminalSessionHeader` (no `TerminalSharingSlot`).
- The chrome hosting the terminal share button renders **only** when `TerminalApp` is mounted with
  `mobile=true` (`shell/src/components/terminal/TerminalApp.tsx:1236`).
- Web Canvas reaches the project share button and both project dialogs, but **not** the terminal share button
  — same mobile-only chrome. Web Mobile reaches everything.

**This is a locked parity requirement, not a platform limitation.** Closing it is task **T078**.

### 4.3 Other open collaboration issues

| Issue | What |
| --- | --- |
| #1862 | `vps:` UUID pattern differs between platform and the shared logical-runtime-id helper |
| #1831 | An admission whose authority check predates a revocation must be refused |
| #1829 | Direct terminal WebSocket answers 404 when a dependency is missing, while HTTP fails loudly — misconfiguration must not look like not-found |
| #1826 | `capability-repository.ts` needs splitting into listing, lifecycle and policy modules |
| #1799 | Extract owner-database startup and collaboration registration from `server.ts` (currently 0.59% covered) |
| #1757 | Expose authenticated pending share invitations to native status |
| #1750 | Lock bound Chat harness controls on mobile |
| #1764 | Validate terminal viewport observers on a physical device |

**#1829 is the one to prioritise** — it is a live fail-open-shaped defect in the same path the journeys
exercise, and a 404 for a missing dependency will be misread as "not shared" during testing.

---

## 5. UI/UX gaps

### 5.1 Four sharing surfaces have no rendered capture at all

`ReadinessSummary`, `ProjectSourceSummary`, `AudienceGrantPicker`, `ResourceSharingButton`.

Nobody has looked at these. They may be correct; there is no evidence either way. **T079** is the task that
exercises owner/member/outsider journeys and records Web Canvas → Web Desktop → Electron evidence. It is open,
and journey 19 cannot reach LIVE while it is.

### 5.2 What to evaluate when they are first rendered

The spec fixes behaviour, not layout. These are the questions a designer should answer on first capture:

- **Pending vs joined.** A member sees an org-wide share as pending until they open it, and opening is the
  accept. Is that legible? A share that looks identical before and after joining makes journey 12's semantics
  invisible.
- **Viewer vs Contributor in a terminal.** A Viewer cannot type. Does the UI say so before they try, or does
  the input silently do nothing? Controller handoff needs a visible holder.
- **Whose resources these are.** Collaborators work on the owner's files, AI and Git identity. Nothing in the
  current copy establishes that continuously; a member could reasonably believe a run costs them money or
  touches their machine.
- **Readiness when something is missing.** Journey 19 requires preflight to name the missing prerequisite —
  Git identity, forge credential, AI source — **without** enumerating resource names the viewer may not see.
  That is a copy problem as much as a logic one.
- **Blocked share.** An unresolvable Chat root must block, not warn. Does it read as a hard stop?
- **Empty states.** Per `specs/ux-guide.md`: icon, headline, description, CTA. A member with no shares yet is
  the first thing a new collaborator sees.

### 5.3 Surface parity is not optional

Web Canvas, Web Desktop and Electron Desktop must expose the same states and actions from shared components.
Today §4.2 breaks that for the share control. Any new capability added during bug-fixing inherits the same
requirement.

---

## 6. Suggested order

1. **Deploy a host bundle to a disposable VPS.** Nothing else is possible first.
2. **Fix #1829** — a misconfiguration that answers 404 will corrupt every subsequent test result.
3. **Run journey 2 (relay transparency).** It validates the central architectural claim. If it fails, the
   order of everything else changes.
4. **Run journey 1 (org-only gate)** with a real outsider account.
5. **Close T078** so Web Desktop and Electron can reach the share control, then **T079** for captures.
6. **Journey 16 (shared coding)** once provider credentials exist — the largest unknown.
7. The remaining journeys in any order; **14 must be four separate runs**.

---

## 7. What "done" means here

A journey is LIVE when it has been exercised against real infrastructure **and the evidence is recorded**.

Two failure modes this release has already produced, both worth avoiding on the way out:

- **A count is not a finding until it says what each item is.** "26 journeys" hides that nine are decisions,
  one has never run, and sixteen are half-done.
- **Verifying the action you took is not verifying the state you wanted.** A test that asserts the URL a
  client builds does not observe whether the server accepts it — which is exactly how Native Mobile stayed
  green while being entirely broken.
