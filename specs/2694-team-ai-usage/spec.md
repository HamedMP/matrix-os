# Organization AI usage

Status: Draft, awaiting owner approval. Ticket: [ENG-500](https://linear.app/matrix-os/issue/ENG-500/team-ai-usage-for-organizations).
Builds on: ENG-440 personal AI usage (`specs/651-ai-usage/`), ENG-494 AI Insights package,
ENG-29 Collaboration & Sharing (`specs/2689-collaborative-app-sharing/`), ENG-490 Share popover
(`specs/2693-share-popover-redesign/`), ENG-458 Core MCP org admin view (precedent for org usage
records), spec 530 org drive (precedent for org data held on one member's computer).

## Goal

An organization turns on AI usage reporting. From then on, everyone in the org sees the same
dashboard: org totals, a named leaderboard, awards, and filters by tool, model and date range.
The org admin also sees reporting health across the company and controls the settings.
Usage is measured from each member's coding-agent history on their own devices. Only daily
counters for organization work leave the device.

Phase 1 is the Matrix org of Hamed, Nima and Johan this week.

## Owner decision (16 November 2026)

The owner decided this is an organization product modelled on an internal dashboard that a real
company built "so everyone gets clarity and leaderboard". Members see each other by name.
Reporting is not something each member opts into individually.

This departs from two existing rules, and this spec scopes them as follows:

- **Spec 651** ("an organization cannot read ... personal usage implicitly", "comparative
  profiles and sharing are optional ... and deferred", "no opaque people rankings") still governs
  **personal** AI usage and the personal Settings panel. It does not govern organization AI usage
  as defined below. The leaderboard is not opaque: every rank and award shows the metric and its
  definition.
- **Constitution I** keeps personal data private and never merged with org data. This spec
  treats AI agent usage **on the organization's work, while the org has reporting turned on**,
  as **org data**: it belongs to the organization, admins control it, and it survives a
  member's departure. Usage outside the org's work stays personal and is never collected
  (see "Keeping personal usage out"). The proposed constitution amendment is at the end of this
  spec (Q7).

## Non-goals

- Prompts, responses, transcripts, code, file contents, commands or any text from a session.
- Bills or invoices. Cost is an API list-price estimate. No "net" amount: Matrix has no
  discount, seat or subscription data, so the reference's net/gross toggle is left out.
- Departments, groups, teams and regions as filters. Clerk orgs have none of these yet (deferred
  until orgs gain groups).
- "Suggestions accepted". Local agent history does not record it.
- Measuring productivity or quality. The copy never equates tokens with output.
- Native Mobile. Shared apps do not run there (spec 2689).

## Who sees what

| Who | Sees | Can do |
| --- | --- | --- |
| Org member (any role) | Full dashboard: org totals, named leaderboard, awards, filters, trend, their own reporting status | Report their usage; see exactly what their devices sent |
| Org admin (`org:admin`) | Everything members see, plus reporting health per member (last report, devices, tools found, gaps) | Turn reporting on or off; set the org-work rule; exclude a member; delete a member's or the whole org's usage data |
| Guest | Phase 1: same as a member (shared-app rule). Phase 2: not shown, unless the admin allows it | None |
| Former member | Nothing | Their past org-work rows stay as org history, labelled "former member" (Q5) |
| Outsider | Nothing | None |
| Platform | Org membership, routing and the reporting policy (on/off, rule). Never the usage rows | None |

## What is collected

Built on the member's device, by code the member runs (AI Insights CLI, then the Matrix desktop
app and CLI). Only sessions that match the org-work rule are counted. The receiver validates
every summary with a strict Zod schema and rejects unknown fields.

`OrgUsageSummary` v1:

| Field | Content |
| --- | --- |
| `contract`, `version` | `"matrix.org-ai-usage.summary"`, `1` |
| `orgId` | Clerk org ID the summary is for |
| `rule` | `{kind, digest}` of the org-work rule it was computed with (see below) |
| `generatedAt`, `timeZone` | ISO timestamp; IANA zone used for day buckets |
| `range` | `{from, to}` local days, at most 90 |
| `producer` | `{name: "ai-insights" \| "matrix-desktop" \| "matrix-cli", version}`, plus `pricingVersion` |
| `device` | Random per-install ID (no hostname) so two laptops are not double counted |
| `coverage[]` | `{harness, found, sessions, issues}`; "not found" is never shown as zero |
| `days[]` | `{day, harness, model, input, cachedInput, cacheWrite, output, requests, usd \| null, unpriced}` |
| `activity[]` | `{day, harness, sessions}` |

- `harness` is one of `claude-code, codex, cursor, pi, opencode, gemini`.
- `model` is a public family label from a fixed allowlist. Anything else becomes "Another model".
- `usd` is null when unpriced. It is never 0 for "unknown".

**What is shown:** member name and avatar (from the org), tools used, tokens, days active,
estimated cost, cost per million tokens, longest streak, last reported. Plus org totals and
trend.

**Never collected:** prompts, responses, transcripts, file contents, tool calls, shell commands,
file paths, repo, project or branch names, session IDs, hostnames, provider account names or
emails, credentials, and any time finer than a day. The AI Insights Recap's personal stats
(voice, politeness, rhythm, night share, persona, findings, tips) are excluded: they describe the
person, not the org's usage.

## Keeping personal usage out: the org-work rule

The admin sets one rule per org. The member's device applies it locally to every session before
counting. A session that does not match is skipped and never leaves the device in any form.

| Rule | How a session matches | Notes |
| --- | --- | --- |
| `git-owners` (**recommended**) | The session's working directory is in a Git repo whose remote owner is on the org's list (for example `github.com/FinnaAI`, `github.com/HamedMP`) | Repo names stay local; only the match result is used |
| `matrix-org-projects` | The session ran in a Matrix project that belongs to the org | Narrow today; most agent use happens outside Matrix projects |
| `whole-device` | Every session on a device the member links to the org | Simplest, but includes personal usage on that device. Only for orgs that want it, such as founders on company laptops |

The summary carries the rule's digest. The dashboard rejects summaries computed with a different
rule than the current one, so a stale or edited rule cannot mix in other usage.

## How a member knows reporting is on

- **Joining or enabling:** when the admin turns it on (or a member joins an org that has it on),
  every member gets a notice: what is collected, what is never collected, the org-work rule, and
  who sees it (everyone in the org).
- **On the device:** the Matrix desktop app and CLI show "Reporting org AI usage to <org>" in
  Settings → AI usage, with the last report time and a "What was sent" view showing the exact
  last payload.
- **In the dashboard:** a header line states the rule and that everyone in the org sees the
  leaderboard.
- **Phase 1:** members create and upload their own summary, so they see it before it is sent.

Whether a member can pause reporting is Q2.

## Data flow and source of truth

```
member device                     host computer (admin's VPS)          everyone in the org
collector applies org rule  ─▶  Org AI usage app (shared to org)  ─▶  opens app from launcher
(local parse + projection)      owner Postgres, app schema             via shared-app relay
                                rows keyed by org ID + actor ID
platform: membership, routing, reporting policy (on/off, rule) only
```

- **Org view source of truth:** the app's tables in the host's owner Postgres, held as delegated
  custody for the org, the same way as the org drive (spec 530). Rows are keyed by Clerk org ID,
  actor ID and device ID, never by handle or home path, so they can move to a dedicated org
  computer later.
- **Why not the platform:** the platform must not become the durable store for org data (spec
  530 boundary). Core MCP keeps usage on the platform only because the platform runs that broker.
- **Why the shared-app model fits:** everyone in the org sees the same data. Shared apps give
  every current member the same access and filter nothing per row, which matches that rule.
- **What shared apps cannot do:** restrict writes or settings to admins, or stamp the writer's
  identity on a row. Phase 1 accepts this for one trusted org (the collaboration audit records
  the real actor of every write). Phase 2 moves writes and admin settings to server-enforced
  routes.
- **Personal AI usage (ENG-440)** stays private and separate. The org collector reads the same
  local history, but it writes only org-rule rollups, and only to the org store.

### Storage

- `member_usage`: `actor_id`, `device_id`, `display_name`, `reported_at`, `generated_at`,
  `producer`, `pricing_version`, `rule_digest`, `range_from`, `range_to`, `summary jsonb` (at most
  128 KB). Unique on (`actor_id`, `device_id`). A new report replaces that device's row.
- `org_settings` (phase 1 only; moves to platform policy in phase 2): rule kind, Git owner list,
  display options.
- The 1 MB shared-app query limit means the app reads member rows in pages of 6 and aggregates
  in the client. Phase 2 aggregates on the server.

## Collection paths

| Path | Phase | Notes |
| --- | --- | --- |
| `ai-insights org-summary --org <orgId> --rule <file> [--since 90d]` | 1 | New AI Insights command (ENG-494). Applies the rule, prints the payload preview, writes the file. Needs an npm release |
| Upload in the app | 1 | The member picks the file; the app validates it and replaces their device row |
| Matrix desktop app (Electron main process) | 2 | Fetches policy for each org with reporting on; reports daily and on demand; shows the indicator |
| `matrix ai-usage report` (CLI), and a scheduled run | 2 | For members who do not use the desktop app or Matrix computer |
| Member's Matrix computer (VPS history) | 2+ | For agents that run on the member's VPS |

Phase 3: Matrix's personal panel and the org collector both use the `ai-insights` package, so
there is one parser (ENG-494). Until then, phase 1 accepts only `ai-insights` producers,
because Matrix's own parser lacks its accuracy fixes.

## The dashboard

Modelled on the reference dashboard:

- **Filters:** tool, model, date range (7 / 30 / 90 days, default 30). Org is implied by the
  share.
- **Awards** (each card names the winner and shows the metric and its definition):
  most tokens, highest estimated cost per active day, longest streak, most tools used, best
  estimated cost per million tokens (only for members with at least 90% of requests priced).
  "Most suggestions accepted" is left out (no data).
- **Leaderboard:** rank with medals for the top 3, member, tools used as coloured chips, tokens,
  days active, estimated cost, and last reported. Sortable by any column, with search by name.
  Rows older than 7 days are labelled stale. Coverage gaps are shown per member.
- **Org cards and trend:** org tokens, estimated cost with priced coverage %, active members,
  and a daily trend by tool.
- **Admin panel** (admins only in phase 2; phase 1 shows it to everyone but only the host acts on
  it): reporting status per member and device, rule settings, exclude or delete.
- **States:** reporting off, no reports yet, host offline, stale, invalid file, rule mismatch.
- Cost is always labelled "API list-price estimate".
- Reuses `packages/ui`, shadcn controls, Matrix theme tokens, and the `packages/ui/src/ai-usage/`
  formatting and heatmap.

### Surface matrix

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | required | required | required | required | required |
| Web Desktop | required | required | required | required | required |
| Electron Desktop | required (dashboard; phase 2 also the reporting indicator) | required | required | required | required |
| Web Mobile | required (responsive app) | required | required | required | required |
| Native Mobile | N/A: shared apps do not run there (spec 2689); needs reviewer approval | N/A | N/A | N/A | N/A |

## Security architecture

### Auth matrix

Phase 1 adds no route. It uses the existing shared-app path:

| Route | Auth | Public |
| --- | --- | --- |
| `GET /api/collaboration/shared-apps[/:scopeId]`, `POST .../launch` (platform) | Clerk session, current org membership | No |
| `/api/collaboration/scopes/:scopeId/apps/:appId[/view\|/assets\|/actions]` (host gateway) | Launch session, active share, fresh membership, exact-build readiness | No |
| `/api/collaboration/apps/:appId/readiness\|share` (host gateway) | Host owner only | No |

Phase 2 (proposed):

| Route | Where | Auth | Limits |
| --- | --- | --- | --- |
| `GET /api/orgs/:orgId/ai-usage/policy` | platform | Clerk session or device token, current member | Returns on/off, rule kind, Git owner list, digest |
| `PUT /api/orgs/:orgId/ai-usage/policy` | platform | `org:admin` from fresh membership | `bodyLimit` 4 KB, strict Zod, audit, member notice |
| `PUT /api/org-ai-usage/:orgId/devices/:deviceId/summary` | host gateway, via collaboration relay | Verified member actor; the server stamps `actor_id`; reporting must be on | `bodyLimit` 256 KB, strict Zod, rule digest must match, one report per device per 10 min, upsert `ON CONFLICT` in one transaction |
| `GET /api/org-ai-usage/:orgId/report` | host gateway | Verified current member (guests by policy) | Zod-validated range and filters; aggregated on the server; result at most 256 KB |
| `GET /api/org-ai-usage/:orgId/admin/status` | host gateway | `org:admin` from fresh membership | Paged, at most 100 per page |
| `DELETE /api/org-ai-usage/:orgId/members/:actorId` | host gateway | `org:admin` | `bodyLimit` 1 KB, transaction, audit |

`orgId`, `actorId` and `deviceId` are validated at the route boundary. Client-supplied identity
or role is never trusted.

### Input validation

- Device side: allowlisted fields only; model labels mapped through the allowlist; finite
  non-negative integers; `usd` a non-negative number or null.
- Receiver side (the app in phase 1, the route in phase 2): file at most 512 KB, strict schema,
  `days` at most 5,000, `activity` at most 600, `coverage` at most 6. Dates inside `range`;
  `orgId` and the rule digest must match the current org. `display_name` comes from membership,
  never from the file. On render, unknown labels are shown as "Another model".

### Error policy

Users see one safe message per failure ("This file is not a valid usage summary", "This summary
was made with an old org rule", "The host's Matrix is offline"). No Zod issues, paths, provider
names or database errors reach the client. Details are logged on the host only.

## Failure modes

- **Host offline:** shared-app unavailable state. Devices keep their summaries and report again
  later.
- **Two devices for one member:** one row per device. Days are summed across devices. Sessions
  that were synced between devices are deduplicated on the device by AI Insights' request-ID
  dedupe, as long as they are read on one device. Usage that is reported from two devices for
  the same copied history is a known risk (see Risks).
- **Concurrent reports:** last write wins per device row. The revision conflict is retried.
- **Uncertain save:** existing `clientRequestId` replay prevents duplicates.
- **Rule changed:** old summaries are flagged "old rule" and leave the totals until they are
  reported again.
- **Reporting turned off:** collection stops; the dashboard shows "off". Data is kept until the
  admin deletes it.
- **Stale or partial:** per-member labels and coverage %. Unpriced cost is never shown as $0.

## Resource limits

- File at most 512 KB. Stored summary at most 128 KB per device. 90-day window. At most 5 devices
  per member.
- Phase 1 reads in pages of 6 rows (1 MB result limit), which works for orgs of up to about 50.
  Phase 2 aggregates on the server, with a 60 s cache per org, range and filter, at most 4
  concurrent builds per host, and a 10 s statement timeout.
- Retention: 13 months of daily rows (matches Core MCP aggregates). The admin can delete earlier.

## Acceptance checks (phase 1)

1. With a fixture history that contains prompts, file paths, project names, and sessions both
   inside and outside the org's repos, `ai-insights org-summary` output contains only the fields
   above and counts only the in-org sessions.
2. Hamed shares the app with the org. Nima and Johan open it from the launcher on Web Desktop and
   Electron Desktop, each uploads a summary, and after reload all three see the same leaderboard,
   awards and totals.
3. Filters change every card, award, leaderboard row and the trend consistently.
4. A summary with the wrong org, wrong rule digest, wrong version or too much data is rejected
   with one safe message, and nothing is written.
5. An outsider with the link gets the no-access state.
6. Cost shows coverage % and is labelled as an estimate; unpriced is never $0.
7. Live evidence for every surface in the matrix, per the repo evidence gate.

Tests: AI Insights contract test (its fixture output parsed by Matrix's Zod schema, plus the
in-org/out-of-org fixture), app tests for validation, aggregation, awards and filters, and the
owner/member/outsider journey on the real shared-app path.

## Phased plan

**Phase 1: this week, the Matrix org (smallest version that works)**
1. AI Insights: `org-summary` command with the `git-owners` and `whole-device` rules, plus a
   contract doc. npm release.
2. Matrix: `OrgUsageSummary` v1 Zod schema in `packages/contracts/src/org-ai-usage/`.
3. Matrix: the `org-ai-usage` default app (`home/apps/org-ai-usage/`, Vite, declared tables,
   collaborative readiness): upload, dashboard, leaderboard, awards, filters, admin panel.
4. Host bundle to Hamed's computer (dev channel, scoped deploy). Hamed shares the app with the
   org and sets the rule. All three report.

**Phase 2: automatic and enforced**
Reporting policy on the platform (admin only), member notices, automatic daily reports from the
desktop app and CLI with the on-device indicator and "What was sent" view, server-stamped
identity and admin-only routes on the host, guests hidden by default, departure handling.

**Phase 3: one parser and richer reporting**
Personal and org usage both through the `ai-insights` package. Comparison with the previous
period. Groups or teams once orgs have them. Spend thresholds. Actual billing only where a
provider offers an authorised org usage API, shown separately from estimates.

Each phase ships with a separate public docs PR in `FinnaAI/matrix-os-site`.

## Risks

- **Leaderboard pressure.** Ranking by tokens and cost can reward spending. This is the owner's
  decision. Mitigations: awards show their definitions, cost per million tokens rewards
  efficiency, and the copy never calls volume productivity.
- **Wrong cost numbers.** List-price estimates can be far from what was paid (subscriptions,
  Fast tier, caching). Mitigations: the AI Insights parser, `pricingVersion` shown per member,
  coverage %, and the label "API list-price estimate".
- **Personal usage leaking in.** It can happen with the `whole-device` rule, or with personal
  repos under an org-listed owner. Mitigations: `git-owners` as the default, and the rule is
  visible to every member.
- **Double counting** when the same history is copied to two devices and both report.
  Mitigation: document "report from one device per history"; phase 2 dedupes on request IDs
  across devices on the host.
- **Members without the desktop app or a Matrix computer.** Phase 1 needs only the CLI and a
  browser. Opening a shared app goes through the platform relay; confirm in the phase 1 dry run
  that this works without the member's own VPS.
- **Phase 1 trust gaps:** any member can edit any row or the rule in the shared app (audited, not
  prevented), and guests see the dashboard. Acceptable for three founders. Phase 2 closes both.
- **Host custody.** If Hamed's computer is down, the dashboard is down.
- **Privacy law.** For EU companies, employee monitoring needs a stated purpose, a notice and
  limited data. The notice, the never-collected list and the org-work rule are the basis.
  Customers remain responsible for their own legal review.

## Stakeholder review (suggested)

- Collaboration and sharing owner (ENG-29 / spec 2689): the use of a shared app for org data, and
  phase 2's server-stamped writes.
- Share popover owner (Nima, ENG-490): sharing flow and launcher badge.
- Org admin and Core MCP owner (ENG-458): the admin policy route and the member-notice pattern.
- AI Insights owner (ENG-494): the `org-summary` contract, rules and release.
- Product, design and whoever owns the constitution: the amendment below.

## Open questions for the owner

**Q1. What counts as org work?**
- (a) **Recommended:** `git-owners`. Sessions in repos whose remote owner is on the org's list
  count; everything else stays private.
- (b) `whole-device` for our org now, since we work on company machines; `git-owners` as the
  default for other orgs.
- (c) Only Matrix org projects.

**Q2. Can a member pause reporting?**
- (a) **Recommended:** no. While a member, org-work usage is reported, and the dashboard shows
  each member's last report. Admins can exclude a member.
- (b) Yes. Paused members show as "paused" on the leaderboard.

**Q3. Phase 1 collection**
- (a) **Recommended:** each of us runs `ai-insights org-summary` and uploads it this week;
  automatic reports come in phase 2.
- (b) Wait for automatic reporting from the desktop app before showing anything.

**Q4. Identity on the leaderboard**
- (a) **Recommended:** name and avatar.
- (b) Name and email, as in the reference.

**Q5. When someone leaves the org**
- (a) **Recommended:** keep their past rows as org history, labelled "former member"; the admin
  can delete them.
- (b) Remove their rows on departure.

**Q6. Host**
- (a) **Recommended:** Hamed's computer hosts the app for the org now, with keys ready to move
  to an org computer later.
- (b) Wait for an org computer.

**Q7. Constitution**
- (a) **Recommended:** amend Principle I in this PR. Proposed text: "Organization work data: AI
  agent usage counters for the organization's work, collected while an org admin has reporting
  turned on and matched on the member's device by the org's published rule, belong to the
  organization. Members are notified, content is never collected, and usage outside the rule
  stays personal."
- (b) A separate constitution PR first.
