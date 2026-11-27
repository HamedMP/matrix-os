# Organization AI usage

Status: Draft. The owner answered Q1–Q7 on 16 November 2026 and Q8 on 24 November 2026. No
questions are open. Ticket:
[ENG-500](https://linear.app/matrix-os/issue/ENG-500/organization-ai-usage-dashboard-and-leaderboard).
Builds on: ENG-440 personal AI usage (`specs/651-ai-usage/`), ENG-494 AI Insights package,
ENG-29 Collaboration & Sharing (`specs/2689-collaborative-app-sharing/`), ENG-490 Share popover
(`specs/2693-share-popover-redesign/`), ENG-458 Core MCP org admin view (precedent for org usage
records), spec 530 org drive (precedent for org data held on one member's computer).

## Goal

An organization turns on AI usage reporting. From then on, everyone in the org sees the same
dashboard: org totals, a named leaderboard, awards, and filters by tool, model and date range.
The org admin also sees reporting health across the company. Each member's Matrix desktop app
reads their coding-agent history on that device, and each member's Matrix computer reads the
history of agents run there. Both report daily counters for org work. Prompts and content never
leave the machine they were created on.

Phase 1 is the Matrix org (Hamed, Nima, Johan).

## Owner decisions (16 November 2026)

- **It is an organization product.** It is modelled on an internal dashboard a real company built
  "so everyone gets clarity and leaderboard". Members see each other by name. Reporting is not
  an individual opt-in.
- **Q1 (org work):** a session counts as org work when its repo's Git owner is on the org's list
  (`git-owners`). Each member can also see all usage on their device, org and personal, in a
  **private view** visible only to them. That private usage never reaches the org.
- **Q2:** members cannot pause reporting. Admins can exclude a member.
- **Q3:** the dashboard waits for automatic reporting from the desktop app. There is no manual
  upload step.
- **Q4:** the leaderboard shows name, email and avatar.
- **Q5:** when someone leaves, their past rows stay as org history, labelled "former member". The
  admin can delete them.
- **Q6:** Hamed's Matrix computer hosts the org app for now.
- **Q7:** Constitution Principle I is amended in this PR (version 2.6.0) with the organization work data scope.
- **Q8 (24 November):** agents run on a member's Matrix computer (for example
  `matrix run -- claude`) count in phase 1. Each Matrix computer reports its own native agent
  history, alongside the desktop app.

These decisions depart from two existing rules. This spec scopes them as follows:

- **Spec 651** ("an organization cannot read ... personal usage implicitly", "comparative
  profiles and sharing are optional ... and deferred", "no opaque people rankings") still governs
  **personal** AI usage, including the private view. It does not govern organization AI usage as
  defined here. The leaderboard is not opaque: every rank and award shows its metric and
  definition.
- **Constitution I** keeps personal data private and never merged with org data. Under this spec,
  AI agent usage **on the organization's work, while the org has reporting turned on**, is
  **org data**: it belongs to the organization, admins control it, and it survives a member's
  departure. Usage outside the org's work stays personal and is never sent. Constitution
  2.6.0 adds this as the "Organization work data" scope (Q7).

## Non-goals

- Prompts, responses, transcripts, code, file contents, commands or any text from a session.
- Bills or invoices. Cost is an API list-price estimate. There is no "net" figure: Matrix has no
  discount, seat or subscription data, so the reference's net/gross toggle is left out.
- Departments, groups, teams and regions as filters. Clerk orgs have none of these yet.
- "Suggestions accepted". Local agent history does not record it.
- Measuring productivity or quality. The copy never equates tokens with output.
- Native Mobile. Shared apps do not run there (spec 2689).
- Manual upload, and pausing reporting (owner decisions Q2 and Q3).

## Who sees what

| Who | Sees | Can do |
| --- | --- | --- |
| Org member (any role) | Full dashboard: org totals, leaderboard (name, email, avatar), awards, filters, trend. Their own reporting status | Their devices report automatically; they can open "What was sent" and use "Report now" |
| Org admin (`org:admin`) | Everything members see, plus reporting health per member and device (last report, tools found, gaps) | Turn reporting on or off; edit the Git owner list; exclude a member; delete a member's or the whole org's data |
| Guest | Phase 1: same as a member (shared-app rule). Phase 2: hidden unless the admin allows it | None |
| Former member | Nothing | Past rows stay, labelled "former member" |
| Outsider | Nothing | None |
| Platform | Org membership, routing and relay metadata. Never the usage rows | None |
| The member alone | Private view: all usage on their desktop device and their Matrix computer, org and personal | Nothing from the private view leaves the machine it was computed on |

## What is collected

Built on the machine where the agents ran, using the AI Insights package: by the Matrix desktop
app on a member's device, or by the gateway on a member's Matrix computer. Each machine is a
separate reporting device. Only sessions matching the org's rule are counted. The receiver validates every report with a strict
Zod schema and rejects unknown fields.

`OrgUsageReport` v1:

| Field | Content |
| --- | --- |
| `contract`, `version` | `"matrix.org-ai-usage.report"`, `1` |
| `orgId` | Clerk org ID |
| `ruleDigest` | Digest of the org rule the report was computed with |
| `member` | `{actorId, name, email, imageUrl}` from the member's signed-in Matrix account (display only; see "Identity") |
| `device` | `{id, kind}`: random per-install ID (never the hostname); `kind` is `desktop` or `matrix-computer` |
| `generatedAt`, `timeZone` | ISO timestamp; IANA zone used for day buckets |
| `range` | `{from, to}` local days, at most 90 |
| `producer` | `{name: "matrix-desktop" \| "matrix-gateway", version, insightsVersion, pricingVersion}` |
| `coverage[]` | `{harness, found, sessions, issues}`; "not found" is never shown as zero |
| `days[]` | `{day, harness, model, input, cachedInput, cacheWrite, output, requests, usd \| null, unpriced}` |
| `activity[]` | `{day, harness, sessions}` |

- `harness` is one of `claude-code, codex, cursor, pi, opencode, gemini`.
- `model` is a public family label from a fixed allowlist. Anything else becomes "Another model".
- `usd` is null when unpriced. It is never 0 for "unknown".

**Shown to everyone in the org:** name, email, avatar, tools used, tokens, days active, estimated
cost, cost per million tokens, longest streak, last reported. Plus org totals and trend.

**Never collected:** prompts, responses, transcripts, file contents, tool calls, shell commands,
file paths, repo, project or branch names, session IDs, hostnames, provider account names or
emails, credentials, and any time finer than a day. The AI Insights Recap's personal stats
(voice, politeness, rhythm, night share, persona, findings, tips) are excluded: they describe the
person, not the org's usage.

### Identity

- In phase 1, a report is written through the shared-app path as the signed-in member. The
  collaboration layer verifies the actor and audits every write.
- Name, email and avatar are display fields. Both reporters take them from the member's own
  signed-in account. Phase 2 reads them on the server from the org membership projection
  (`organization_memberships.display_name/email/image_url`), and the report no longer carries
  them.
- Avatar images may be blocked by the shared-app sandbox's content policy. If they are, the app
  shows initials until the host serves avatars through a same-origin route (to verify in the
  spike).

## Keeping personal usage out

**The org rule (`git-owners`).** The admin keeps a list of Git owners for the org (for example
`github.com/FinnaAI`, `github.com/HamedMP`). For each session, the reporter finds the repo of
the session's working directory and reads its remotes from `.git/config` locally, without
running Git. It then normalises each remote to host/owner. The session counts only if one of
them is on the list. Repo names and paths are used only for that local check. Sessions that do
not match are skipped and never leave the machine in any form. On a Matrix computer the check
runs against the repos in the owner's home, where those agents ran.

**The private view.** Settings → AI usage, the existing personal panel (ENG-440), gains an
"Org work / Everything" toggle. "Everything" shows all usage on the device to the member only.
It is computed on the machine that holds the history and never sent to the org. On Web Canvas
and Web Desktop it shows the Matrix computer; on Electron Desktop it shows both.

The report carries the rule digest. The dashboard leaves out reports computed with an old rule
until the device reports again with the current one.

## How a member knows reporting is on

- **Notice:** when the admin turns reporting on, or a member joins an org that has it on, the
  member sees a one-time notice in Electron Desktop and in the web OS views (shown once per
  member, recorded on their Matrix computer). It says what is collected, what is never collected, the
  Git owner list, and that everyone in the org sees the leaderboard, including name and email.
- **Indicator:** Settings → AI usage shows "Reporting org AI usage to <org>" for each reporting
  device (this Mac, this Matrix computer), the last report time, a "Report now" button, and "What
  was sent", which shows the exact last payload.
- **Dashboard header:** shows the rule, and that everyone in the org sees the leaderboard.
- Members cannot pause reporting (Q2). Admins can exclude a member.

## Data flow and source of truth

```
member device (Matrix desktop app) ─┐
                                    ├─▶ host computer (Hamed's VPS)          ──▶ everyone in the org
member's Matrix computer (gateway) ─┘   Org AI usage app (shared to org)          open app from launcher
AI Insights reads native history        owner Postgres, app schema                via shared-app relay
applies org rule, builds report         rows keyed by org + actor + device
writes as the signed-in member
```

- **Org view source of truth:** the app's tables in the host's owner Postgres, held as delegated
  custody for the org, the same way as the org drive (spec 530). Rows are keyed by Clerk org ID,
  actor ID and device ID, never by handle or home path, so they can move to a dedicated org
  computer later.
- **Why not the platform:** the platform must not become the durable store for org data (spec
  530 boundary). Core MCP keeps usage on the platform only because the platform runs that broker.
- **Why a shared app fits:** everyone in the org sees the same data. Shared apps give every
  current member the same access and do not filter by row, which matches that rule.
- **What shared apps cannot do:** restrict writes or settings to admins, or stamp the writer on a
  row. Phase 1 accepts this for one trusted org; every write is audited with its real actor.
  Phase 2 moves writes and admin settings to server-enforced routes.
- **Personal AI usage (ENG-440)** stays separate. The org reporters read the same local history,
  but send only org-rule rollups, and only to the org app.

### Storage (declared app tables)

- `member_usage`: `actor_id`, `device_id`, `name`, `email`, `image_url`, `reported_at`,
  `generated_at`, `producer`, `pricing_version`, `rule_digest`, `range_from`, `range_to`,
  `excluded boolean`, `former boolean`, `summary jsonb` (at most 128 KB). Unique on (`actor_id`,
  `device_id`). A new report replaces that device's row.
- `org_settings`: reporting on/off, Git owner list, rule digest. (Phase 2 moves this to an
  admin-only route.)
- The shared-app query limit is 1 MB. The app therefore reads member rows in pages of 6 and
  aggregates in the client. Phase 2 aggregates on the server.

## The desktop reporter (phase 1)

- Lives in the Electron main process, next to `desktop/src/main/usage-sync/`. It uses the
  `ai-insights` package as a library; this is the first place Matrix consumes it (ENG-494).
- Runs at app start, then every 24 hours, and on "Report now". Runs are coalesced. Signing out or
  switching account cancels the run; quitting drains it.
- For each org the member belongs to that has an active `org-ai-usage` share: read
  `org_settings`. If reporting is off, do nothing. Otherwise build the report and write it.
- On failure, keep the last report, show a safe error in Settings → AI usage, and retry next run.
- **Spike first:** confirm that the main process can open a shared-app session and call the
  existing query/mutation routes as the signed-in member. If it cannot, bring forward the phase 2
  host route (`PUT /api/org-ai-usage/:orgId/devices/:deviceId/report`) through the same
  collaboration relay.

## The Matrix computer reporter (phase 1, Q8)

- Lives in the member's gateway, in a new `packages/gateway/src/org-ai-usage/` module next to
  `packages/gateway/src/ai-usage/`. It uses the same `ai-insights` library call and the same
  `OrgUsageReport` v1 schema as the desktop reporter; only the device kind and producer differ.
- **Reads native agent roots only** (`~/.claude/projects`, `~/.codex/sessions`, and the other
  AI Insights harness roots under the owner's home). It never reads the ENG-440 Mac backup root
  or `system/ai-usage-sources.json` extra sources, so Mac history synced to the VPS is not
  counted twice.
- **Startup:** starts after the owner database, the request principal and the org membership
  client are ready; first run 5 minutes after boot, then every 24 hours, and on "Report now".
  Runs are coalesced. The timer and any in-flight run are cancelled on gateway shutdown.
- **Org discovery:** uses the existing platform membership assertions (fail closed, cached to
  expiry) to find the owner's orgs, and the shared-app directory to find an active
  `org-ai-usage` share. If reporting is off or the member is excluded, it does nothing.
- **Writes:** through the same path the spike picks for the desktop reporter, as the runtime
  owner. The spike must prove this for a runtime-authenticated caller as well as for the
  desktop main process; if the shared-app routes need a Clerk browser session, both reporters use
  the brought-forward host report route, authenticated by a platform-issued runtime assertion
  for the member.
- **State:** device ID, notice acknowledgement, last payload and last error are kept in the
  owner Postgres (one row per org, `ON CONFLICT` upsert), not in memory.
- On failure, keep the last report, show a safe error in Settings → AI usage, and retry next run.

## The dashboard

Modelled on the reference dashboard:

- **Filters:** tool, model, date range (7 / 30 / 90 days, default 30), and search by name or
  email.
- **Awards** (each card names the winner and shows the metric and its definition): most tokens,
  highest estimated cost per active day, longest streak, most tools used, best estimated cost per
  million tokens (only for members with at least 90% of requests priced).
- **Leaderboard:** rank with medals for the top 3; member (avatar, name, email); tools used as
  coloured chips; tokens; days active; estimated cost; last reported. Sortable by any column.
  Rows older than 3 days are labelled stale. Coverage gaps are shown per member. Former members
  are labelled.
- **Org cards and trend:** org tokens, estimated cost with priced coverage %, reporting members,
  daily trend by tool.
- **Admin panel:** reporting status per member and device, Git owner list, exclude, delete. In
  phase 1 only the host acts on it; members see it read-only by convention, not enforcement.
- **States:** reporting off, no reports yet, host offline, stale, rule changed.
- Cost is always labelled "API list-price estimate".
- Reuses `packages/ui`, shadcn controls, Matrix theme tokens, and the `packages/ui/src/ai-usage/`
  formatting and heatmap.

### Surface matrix

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | required (dashboard; notice, Matrix computer indicator and private-view toggle in Settings) | required | required | required | required |
| Web Desktop | required (dashboard; notice, Matrix computer indicator and private-view toggle in Settings) | required | required | required | required |
| Electron Desktop | required (dashboard, notice, indicators for this Mac and the Matrix computer, private-view toggle) | required | required | required | required |
| Web Mobile | required (responsive dashboard) | required | required | required | required |
| Native Mobile | N/A: shared apps do not run there (spec 2689); needs reviewer approval | N/A | N/A | N/A | N/A |

## Security architecture

### Auth matrix

Phase 1 uses the existing shared-app routes. It adds a route only if the spike fails.

| Route | Auth | Public |
| --- | --- | --- |
| `GET /api/collaboration/shared-apps[/:scopeId]`, `POST .../launch` (platform) | Clerk session, current org membership | No |
| `/api/collaboration/scopes/:scopeId/apps/:appId[/view\|/assets\|/actions]` (host gateway) | Launch session, active share, fresh membership, exact-build readiness | No |
| `/api/collaboration/apps/:appId/readiness\|share` (host gateway) | Host owner only | No |
| Desktop reporter IPC (`ai-usage:org-status`, `ai-usage:org-report-now`, `ai-usage:org-last-payload`) | Trusted main frame, current signed-in runtime generation (existing AI usage IPC pattern) | No |
| `GET /api/ai-usage/org/status`, `GET /api/ai-usage/org/last-payload`, `POST /api/ai-usage/org/report-now`, `POST /api/ai-usage/org/notice-ack` (member's own gateway, Matrix computer reporter) | Runtime owner only, like `GET /api/ai-usage`; `bodyLimit` 1 KB on POSTs; report-now limited to once per 10 minutes | No |

Phase 2 (proposed):

| Route | Where | Auth | Limits |
| --- | --- | --- | --- |
| `GET/PUT /api/orgs/:orgId/ai-usage/policy` | platform | GET: current member. PUT: `org:admin` from fresh membership | `bodyLimit` 4 KB, strict Zod, audit, member notice on change |
| `PUT /api/org-ai-usage/:orgId/devices/:deviceId/report` | host gateway, via collaboration relay | Verified member actor; the server stamps the actor and reads identity from membership; reporting must be on and the member not excluded | `bodyLimit` 256 KB, strict Zod, rule digest must match, one report per device per 10 minutes, upsert `ON CONFLICT` in one transaction |
| `GET /api/org-ai-usage/:orgId/report` | host gateway | Current member (guests by policy) | Zod-validated range and filters; aggregated on the server; result at most 256 KB |
| `GET /api/org-ai-usage/:orgId/admin/status` | host gateway | `org:admin` | Paged, at most 100 per page |
| `DELETE /api/org-ai-usage/:orgId/members/:actorId` | host gateway | `org:admin` | `bodyLimit` 1 KB, transaction, audit |

`orgId`, `actorId` and `deviceId` are validated at the route boundary. Client-supplied identity
or role is never trusted.

### Input validation

- **Device:** allowlisted fields only; model labels mapped through the allowlist; counters are
  finite non-negative integers; `usd` is a non-negative number or null. The Git owner list from
  `org_settings` is validated (at most 50 entries, `host/owner` pattern) before use. A malformed
  list stops reporting rather than widening it.
- **App, before writing:** report at most 512 KB, strict schema, `days` at most 5,000, `activity`
  at most 600, `coverage` at most 6. Dates must fall inside `range`. `orgId` and `ruleDigest`
  must match the org's. The app writes only for the verified current participant's `actorId`.
  On render, unknown labels are shown as "Another model". Email and name are rendered as text,
  never as HTML.

### Error policy

Users see one safe message per failure ("Couldn't report usage; we'll retry", "The host's Matrix
is offline", "The org rule changed; reporting again"). No Zod issues, paths, provider names or
database errors reach the client. Details are logged locally on the device, and on the host
only.

## Failure modes

- **Host offline:** the dashboard shows the shared-app unavailable state. Devices retry next run.
- **Two devices for one member:** one row per device (for example a Mac and a Matrix computer),
  summed per day. If the same history is copied between devices (for example the ENG-440 Mac →
  Matrix sync), only the device where it was created reports it. Both reporters read only native
  agent roots, never recovered backups.
- **Matrix computer asleep, restarting or updating:** the run is skipped and retried at the next
  boot or interval; the dashboard shows that device's last report time.
- **Concurrent reports:** last write wins per device row. A revision conflict is retried once.
- **Uncertain save:** the existing `clientRequestId` replay prevents duplicates.
- **Rule changed:** reports made under the old rule leave the totals until the next run.
- **Reporting off or member excluded:** the reporter stops. Rows are kept until the admin deletes
  them.
- **Member leaves:** their access ends and their devices stop reporting. Rows are relabelled
  "former member" the next time the host sees that membership has ended.
- **Desktop not installed or not running:** no reports from that person. The dashboard shows
  "last reported N days ago" or "not reporting".

## Resource limits

- Report at most 512 KB; stored summary at most 128 KB per device; 90-day window; at most 5
  devices per member.
- Each reporter runs at most once per 10 minutes per org, with the existing AI usage scan
  budgets for file size and time, and is cancellable. On a Matrix computer it runs at low
  priority and never more than one scan at a time.
- Phase 1 reads in pages of 6 rows, which works for orgs of up to about 50. Phase 2 aggregates on
  the server, with a 60 s cache per org, range and filter, at most 4 concurrent builds per host,
  and a 10 s statement timeout.
- Retention: 13 months of daily rows (matches Core MCP aggregates). The admin can delete earlier.

## Acceptance checks (phase 1)

1. With a fixture history that contains prompts, file paths, project names, and sessions both
   inside and outside the org's Git owners, the reporter's payload contains only the fields above
   and counts only the in-org sessions. "What was sent" shows that same payload.
2. Hamed shares the app and sets the Git owner list. On Nima's and Johan's Electron Desktop the
   notice appears, then a report is sent with no manual step. All three see the same leaderboard,
   awards and totals on Web Desktop and Electron Desktop.
3. Filters change every card, award, leaderboard row and the trend consistently.
4. A report with the wrong org, an old rule digest, the wrong version or too much data is
   rejected, and nothing is written.
5. An outsider with the link gets the no-access state.
6. The private view shows all usage to its owner, and nothing beyond org-rule rollups reaches the
   org app (network capture during a run).
7. An agent run on a member's Matrix computer in an org repo appears on the dashboard under that
   member, as a separate "Matrix computer" device, with no manual step. Mac history synced to
   that Matrix computer by ENG-440 is not counted again.
8. Cost shows coverage % and the estimate label; unpriced is never $0.
9. Live evidence for every surface in the matrix, per the repo evidence gate.

Tests: the AI Insights contract test (its output parsed by Matrix's Zod schema), rule-matching
tests on real `.git/config` shapes (HTTPS, SSH, multiple remotes, no remote), scheduling and
cancellation for both reporters, a root-selection test proving the Matrix computer reporter skips
the Mac backup root, app tests for validation, aggregation, awards and filters, and the
owner/member/outsider journey on the real shared-app path.

## Phased plan

**Phase 1: the Matrix org**
0. Spike: can the Electron main process, and the member's gateway, write to a shared app as the
   signed-in member?
1. AI Insights: a library function `orgReport({ rule, since })` with `git-owners` matching, plus
   a contract doc. npm release.
2. Matrix: `OrgUsageReport` v1 Zod schema in `packages/contracts/src/org-ai-usage/`.
3. Matrix: the `org-ai-usage` default app (`home/apps/org-ai-usage/`): dashboard, leaderboard,
   awards, filters, admin panel.
4. Matrix desktop: the reporter, the notice, the Settings indicator, "What was sent", and the
   private-view toggle.
5. Matrix gateway: the Matrix computer reporter and its owner-only routes, plus the same notice,
   indicator and private-view toggle in the web Settings → AI usage (Q8).
6. Host bundle to all three Matrix computers (dev channel, scoped deploys) and a desktop build for
   the three of us. Hamed shares the app and sets the owner list.

Because the dashboard waits for automatic reporting (Q3), phase 1 includes both reporters. It is
unlikely to land within this week.

**Phase 2: real orgs**
Admin-only policy on the platform, server-stamped identity and admin-only routes on the host,
`matrix ai-usage report` in the CLI for people without the desktop app, guests hidden by
default, and automatic former-member labelling.

**Phase 3: one parser and richer reporting**
The personal panel also reads through `ai-insights`. Comparison with the previous period. Groups
or teams once orgs have them. Spend thresholds. Actual billing only where a provider offers an
authorised org usage API, shown separately from estimates.

Each phase ships with a separate public docs PR in `FinnaAI/matrix-os-site`.

## Risks

- **Leaderboard pressure.** Ranking by tokens and cost can reward spending. This is the owner's
  decision. Mitigations: awards show their definitions, cost per million tokens rewards
  efficiency, and the copy never calls volume productivity.
- **Emails visible org-wide** (Q4). That is fine inside one company, but guests also see them in
  phase 1. Mitigation: phase 2 hides guests by default.
- **Wrong cost numbers.** List-price estimates can be far from what was paid. Mitigations: the AI
  Insights parser, `pricingVersion` per member, coverage %, and the estimate label.
- **Personal usage leaking in** through personal repos under an org-listed owner. Mitigation: the
  owner list is visible to every member, and the admin should list org-only owners.
- **Double counting** between a Mac and its Matrix computer. Mitigation: native roots only on
  both reporters, plus acceptance check 7.
- **Load on Matrix computers.** A scan competes with the owner's own agents. Mitigation: low
  priority, one scan at a time, the existing scan budgets.
- **No desktop app, no data.** Members without it, or who rarely open it, under-report. The
  dashboard shows "last reported" and "not reporting" openly.
- **Phase 1 trust gaps:** any member can edit any row or the settings in the shared app (audited,
  not prevented), and guests see the dashboard. Acceptable for three founders; phase 2 closes
  both.
- **Host custody.** If Hamed's computer is down, the dashboard is down.
- **Privacy law.** For EU companies, employee monitoring needs a stated purpose, a notice and
  limited data. The notice, the never-collected list and the org rule are the basis. Customers
  remain responsible for their own legal review.

## Stakeholder review (suggested)

- Collaboration and sharing owner (ENG-29 / spec 2689): a shared app as the org store, the
  desktop-as-participant spike, and phase 2's server-stamped writes.
- Share popover owner (Nima, ENG-490): sharing flow and launcher badge.
- Org admin and Core MCP owner (ENG-458): the admin policy route and the member-notice pattern.
- AI Insights owner (ENG-494): `orgReport`, rule matching and release.
- Desktop owner: the reporter in the Electron main process.
- Gateway owner: the Matrix computer reporter, its startup wiring and owner-only routes (Q8).
- Whoever owns the constitution: the 2.6.0 amendment.

## Open questions for the owner

None. Q1–Q8 are recorded under "Owner decisions".
