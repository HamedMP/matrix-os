---
name: daily-update
description: Write a short, paste-ready daily update of what the current user shipped, started, and moved forward on a day, from their GitHub PRs, Linear tickets (through the Linear MCP server), and agent terminals, with each PR as a Markdown link and a one-line description. Use when asked for a daily update, standup notes, or what I shipped yesterday.
---


# Daily Update

Use this skill when the requester asks for a daily update, standup notes, or a
summary of what they shipped or started on a day, or invokes `daily-update`.
The request may name a day (`yesterday`, `today`, a date) and a GitHub login;
by default it covers yesterday for the current user.

## Goal

Produce a short, paste-ready Markdown update of one person's work on one day:
what merged, what was opened, what moved forward, and what agents are working
on that has no PR yet. Every PR is a Markdown link with a few words on what it
does for users or the team.

## Scope

- Day: `yesterday` by default; also `today` or a date (`2026-11-11`). Use the
  author's local time zone (`date +%z`, or ask once if the machine's zone is
  clearly not theirs). Say in the update which day and zone it covers.
- Author: the current user by default (`gh api user -q .login`, and the Linear
  MCP `whoami` when Linear is connected). A GitHub login covers that person
  instead; agent terminals are included only when they are the current user's.
- Repository: the current one (`gh repo view --json nameWithOwner`).

## Rules

- Read-only. Do not post to Slack, Linear, or GitHub, and do not change any
  ticket or PR. The update is the reply; the author posts it.
- Use the day's start and end in the local zone with an explicit offset in
  every GitHub search, for example
  `merged:2026-11-11T00:00:00+01:00..2026-11-11T23:59:59+01:00`. Plain
  `merged:2026-11-11` is a UTC day and puts late-evening work on the wrong day.
- Describe outcomes, not implementation: "offer Helsinki as a server location",
  not the commit title or file names. One line per PR.
- Group a stack under one line naming the stack and its ticket, with each layer
  as a short sub-bullet.
- Leave out PRs by bots (dependabot, renovate) unless the author merged them,
  and leave out PRs whose only activity that day was bot comments or CI runs.
- The repo may be public and the update may be shared: no customer names,
  hosts, IPs, credentials, or private incident details. Keep private reports
  (such as security reviews) out.
- Retry a failed GitHub call once. In a sandboxed agent, GitHub calls may need
  the requester to approve network access; ask for read-only approval rather
  than reporting GitHub as empty.
- Report what you could not check. If Linear or `hc` is unavailable, say so in
  one line at the end; never present a missing source as "nothing happened".

## Steps

1. **Collect PRs.** Run these together for the author and day:
   - Merged: `gh pr list --author <login> --state merged --search "merged:<start>..<end>" --limit 100 --json number,title,url,mergedAt,headRefName,baseRefName,body`.
   - Opened: `gh pr list --author <login> --state all --search "created:<start>..<end>" --limit 100 --json number,title,url,state,isDraft,headRefName,baseRefName,body`.
     Drop the ones already in the merged list; they belong under Shipped.
   - Moved forward: open PRs updated that day but created before it. The
     search needs both bounds written out, for example
     `"updated:2026-11-11T00:00:00+01:00..2026-11-11T23:59:59+01:00 created:<2026-11-11T00:00:00+01:00"`,
     with `--state open --limit 100 --json number,title,url,isDraft,headRefOid,baseRefName`.
     Keep a PR only if something real happened that day:
     - a commit: `gh pr view <n> --json commits`, `committedDate` in range;
     - a review or score: `gh pr view <n> --json reviews` (`submittedAt` in
       range), or a Greptile summary comment updated in range;
     - draft or ready: `gh api repos/<owner>/<repo>/issues/<n>/timeline` events
       `ready_for_review` or `convert_to_draft` with `created_at` in range.
   - A PR's day is the day it was opened or merged, not its commit dates; late
     commits can carry the next day's date.
   - A stack whose layers target each other (not `main`) counts as shipped when
     its layers merged into `main` together; report it under Shipped as one
     stack.
   - If a list returns exactly 100, page further or say "100 or more".

2. **Collect tickets** (Linear MCP, when connected; tool names may carry a
   server prefix such as `mcp__linear-server__`): `whoami`, then
   `list_issues` with the author as assignee and `completedAt` set to the day
   for finished tickets. There is no started-date filter: list with
   `updatedAt` from the day's start and keep issues whose `startedAt` falls in
   the day.
   Use them to name each PR's ticket (match by `gitBranchName` or a ticket ID
   such as `ENG-123` or `GTM-305` in the branch, title, or body) and to find
   work that has no PR. Do not report ticket-status mismatches (such as a
   merged PR whose ticket is still open) inside the update; mention them in the
   closing lines instead.

3. **Collect agent work** (when `hc` is available and the author is the current
   user): `hc ls --all`. `hc` is often only on the login-shell `PATH`; try
   `command -v hc`, then `~/.local/bin/hc`, before treating it as unavailable. For each terminal created or active that day whose
   worktree has no PR in step 1, read its last report (`hc read <t> --lines 40`)
   and take one line: what it is building and where it stands. Skip helper
   terminals (renames, tests, one-shot lookups) and terminals with nothing to
   report.

4. **Write the update** in this order, leaving out empty sections:
   - Heading line: the day, zone, and author.
   - **Shipped**: merged PRs.
   - **Started**: PRs opened that day and still open.
   - **Moved forward**: older open PRs with real progress, each with the one
     fact that changed (fixed review findings, rebased, CI green, waiting on X).
   - **In progress, no PR yet**: agent work and started tickets without a PR.
   - Optional final line: what is blocked on someone else, only if it matters
     to readers.

   Format each PR as `- [#123](<url>): <what it does> (<TICKET-ID>).` Keep the
   whole update under about 35 lines.

5. **Close.** Give the update in one copyable block. After it, in one or two
   lines outside the block, list anything left out on purpose (other days' work,
   bot PRs, private items) and any source that could not be checked.
