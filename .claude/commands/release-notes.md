---
description: Draft user-facing Desktop release notes (release-notes/<version>.json) from PRs merged since the last release on a channel, validate them, and commit after approval.
argument-hint: [version] [dev | canary | beta | stable]
---

# Release Notes

Usage: `/release-notes [version] [dev | canary | beta | stable]`

Arguments:

```text
$ARGUMENTS
```

## Goal

Write `release-notes/<version>.json`: the user-facing notes that the What's
New dialog shows after a Desktop update and keeps in its release history.
Users read it, not engineers. Engineering detail stays in the GitHub release
body, which the dialog links as "Technical release notes".

## Scope

- Version: the argument, or derived from `desktop/package.json` `version`
  when omitted. Drop any prerelease suffix to get the base `X.Y.Z`. On
  `canary` the version is `X.Y.Z-canary`: canary builds ship as
  `X.Y.Z-canary.<stamp>` and only a `-canary` entry matches every one of
  them. On `dev`, `beta`, and `stable` use the exact release version.
- Channel: `canary` by default; also `dev`, `beta`, or `stable`.
- Range: everything merged to `main` since the previous release on that
  channel. Desktop releases are tagged `desktop-v<version>` (immutable) and
  `desktop-<channel>` (moving pointer to the channel's latest release).

## Rules

- Write the file before the release build. The renderer bundles
  `release-notes/*.json` at build time, so notes committed after the build
  never reach that release.
- A person approves the text. Show the draft and wait for an explicit yes
  before committing. Never publish or promote a release from this skill.
- Leave out internal work: docs, specs, chores, CI, tests, skills, agent
  tooling, dependency bumps, and refactors with no visible effect. Record
  every left-out PR number in `hidden` so the triage can be audited.
- Merge related PRs into one highlight or item. A stack is one change.
- Plain language for users: what they can now do or what stopped going wrong.
  No PR numbers, Conventional Commit prefixes, branch, package, or internal
  code names, and no ticket IDs in the copy.
- Name the affected surfaces from the changed paths and PR body:
  `web-desktop`, `web-canvas`, `electron-desktop`, `web-mobile`,
  `native-mobile`. Leave `surfaces` out when a change applies everywhere.
- The repository is public: no customer names, hosts, IPs, or incident detail.
- Translations are future work. Write English and keep `"locale": "en"`.

## Steps

1. **Find the range.** `git fetch origin --tags`, then use
   `git rev-parse desktop-<channel>` as the previous release on the channel.
   If that tag is missing, use the newest `desktop-v*` tag that is an
   ancestor of `origin/main` and say so in the draft.
2. **List merged PRs.**
   `git log --first-parent --format='%H %s' desktop-<channel>..origin/main`
   gives the squash commits; take the `(#NNNN)` numbers and read each with
   `gh pr view <n> --json number,title,body,labels,files`. Prefer a
   `## User-facing` line in the PR body when the author wrote one.
3. **Triage.** Sort each PR into highlight, item (`new`, `improved`,
   `fixed`), or hidden. Pick at most two or three highlights: the changes a
   user would notice first. Everything else visible is a one-line item.
4. **Write the JSON.** Shape (see `desktop/src/shared/release-notes.ts` for
   the schema and limits):

   ```json
   {
     "version": "0.1.24-canary",
     "channel": "canary",
     "date": "2026-11-16",
     "locale": "en",
     "title": "Your agents, at a glance",
     "shortTitle": "Agents everywhere",
     "summary": "One or two sentences on what this release means for the user.",
     "highlights": [
       {
         "tag": "Highlight",
         "title": "Agent status everywhere",
         "body": "Two sentences, written for the user.",
         "surfaces": ["web-desktop", "web-canvas", "electron-desktop"],
         "art": "agents",
         "tone": "lime",
         "prs": [3297, 3299]
       }
     ],
     "items": [{ "kind": "fixed", "text": "Shared chats stay available when the connection is slow." }],
     "hidden": [3386, 3284]
   }
   ```

   Give every highlight an illustration and a gradient tone:
   - `art`: `agents` (agent status, runs, inbox), `terminal` (terminals,
     CLI, shells), `notification` (alerts, mobile, chats that reach you),
     `sync` (sharing, collaboration, sync), `shield` (security, fixes,
     reliability), or `sparkle` (anything else new).
   - `tone`: `lime`, `teal`, `sand`, or `ink`. Give neighbouring highlights
     different tones; `ink` suits terminal and developer features.
   Omitted values fall back by position, so set them explicitly. An optional
   `media` image (a bare, lowercase file name in `release-notes/media/`: webp, png, jpg,
   or avif, ideally under 300 KB) replaces the illustration. Take screenshots
   from the live running build, never mockups.
5. **Validate.** `bun run release-notes:validate` (or
   `node scripts/release-notes/validate.mjs`). Fix every error.
6. **Preview** when you can: run the Desktop dev build with
   `VITE_MATRIX_DESKTOP_PREVIEW_WHATS_NEW=1 pnpm --dir desktop dev` and check
   the dialog in light and dark themes.
7. **Ask for approval.** Show the title, summary, highlights, items, and the
   hidden PR list with a one-word reason each. Apply edits and validate again.
8. **Commit after approval**, before starting the release build, through the
   normal worktree PR flow (never directly to `main`):
   `git add release-notes/<version>.json release-notes/media/<files>` and
   `git commit -m "docs(release-notes): add <version> notes"`.

## Output

The draft for approval, then the file path and validator result. Say which
sources you could not read (for example a `gh` failure) rather than leaving
PRs out silently.
