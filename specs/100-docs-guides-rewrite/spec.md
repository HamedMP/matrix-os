# Spec 100 — Docs Guides Rewrite (www `/docs`)

**Date:** 2026-06-28
**Status:** Design — awaiting review
**Scope:** `www/content/docs/**`, `www/src/app/docs/**`, `www/src/lib/layout.shared.ts`, `www/next.config.*`

## Goal

Rewrite the user-facing `/docs` ("Guides") from scratch so a developer who runs AI
coding agents can land, understand what Matrix OS is, provision a computer, and use it
from the web shell, CLI, mobile, and desktop. Drafted from the actual codebase; the
maintainer corrects specifics.

## Positioning

- **Headline framing:** "Matrix OS is your **cloud coding computer**."
- **Audience sub-text:** "for developers who run AI coding agents."
- Product-forward headline with audience as supporting line (not audience-forward).

## Section model (dropdown)

The docs sidebar uses the fumadocs root-toggle **dropdown** (already implemented),
`tabMode` default (sidebar dropdown, not the horizontal bar). Two **visible** sections:

| Section | url | icon | default | visible |
|---------|-----|------|---------|---------|
| **Guides** | `/docs` | `Rocket` | yes | yes |
| **Developers** | `/docs/developer` | `Terminal` | no | yes |
| _Cloud Computer_ | `/docs/guide` | _tbd_ | no | **hidden (future)** |

> Guides pages live flat at the `/docs` root (no `users/` folder); the Developers section
> stays scoped under `/docs/developer` with Deployment folded in as a sub-folder.
>
> **Hidden 3rd section.** The existing `guide/` content becomes a future "Cloud Computer"
> section. It is hidden now simply by **not listing it in `sidebar.tabs`**: because the
> dropdown uses explicit tabs, the `guide/` root folder produces no dropdown entry, and
> root folders are excluded from the parent (`/docs`) sidebar — so its pages are reachable
> only by direct URL until a `{ title: 'Cloud Computer', url: '/docs/guide' }` tab is added.

## Information architecture — Guides (11 pages)

Order = sidebar order. "Source" = where I draft content from.

1. **About** (`index.mdx`) — what Matrix OS is (cloud coding computer for devs who run AI
   agents), the persistent-workspace mental model, the four surfaces (web / CLI / mobile /
   desktop). Source: positioning above + existing `index.mdx` + `specs/web4-vision.md`.
2. **Quickstart** (`quickstart.mdx`) — sign up → choose power/region → pay → provision →
   land in the shell. Source: existing quickstart + onboarding flow.
3. **CLI** (`cli.mdx`) — install; `matrix login`; `matrix run -it -- claude`;
   `matrix shell connect -c <session>`; file **sync** (`sync`/`upload`/`download`);
   **port forwarding** (`matrix port forward` / `matrix forward` — forward a local
   loopback port to the Matrix computer); `status`/`whoami`/`doctor`. Source:
   `packages/sync-client/src/cli/commands/*`.
4. **Web Shell** (`shell.mdx`) — terminal, GitHub auth (`gh auth login` inside a session),
   zellij named sessions, file browser. Source: shell code + CLAUDE.md shell gotchas.
   **Callout (required):** when `gh auth login` creates an SSH key in the shell, advise the
   user to **set a passphrase/password for that SSH key** (don't leave it empty). Repeat the
   same callout wherever the CLI page shows `gh auth login`.
5. **Coding Agents** (`coding-agents.mdx`) — Claude, Codex, Pi, OpenCode; installing an
   agent from the Terminal `+` menu (`npm i -g --prefix $MATRIX_NODE_PREFIX`). Source:
   `packages/platform/src/developer-tools.ts`, `TerminalApp.tsx`.
6. **Hermes (Chat)** (`hermes.mdx`) — the always-on chat agent. **Prominent requirement:
   Hermes needs a Claude login** to operate; document what works / what's gated without it,
   and how to connect it. Source: `packages/gateway/src/messages/hermes-*.ts`,
   `hermes-capability.ts`.
7. **Matrix Skills** (`matrix-skills.mdx`) — agent skills + canonical pack. Source: existing
   page + `skills/matrix/`. Trim.
8. **Mobile** (`mobile.mdx`) — mobile shell/app, mobile terminal view. Source:
   `apps/mobile/**`, salvaged from orphaned `guide/mobile.mdx`. **New page.**
9. **Messages** (`messages.mdx`) — messaging channels. Keep, light edit.
10. **Desktop App (Operator)** (`desktop.mdx`) — the Electron app. Keep, light edit.
11. **Settings & Billing** (`settings-billing.mdx`) — plan, compute, region, billing. Keep.

## Structural changes

1. **Section labels** → `Guides` / `Developers` in `docs/layout.tsx` `sidebar.tabs`
   (icons sized `size-4`). Set `developer/meta.json` title to `Developers` to match.
2. **`guide/` folder — keep, hidden** (15 pages: agents, file-system, channels,
   developer-workflow, cli, cloud-coding, system-activity-monitor, apps, social,
   getting-started, integrations, app-store, mobile, design-system, storage). **Do not
   delete.** It becomes the future "Cloud Computer" section. Hidden now by omission from
   `sidebar.tabs` (see Section model). The new Guides **Mobile** page is written fresh from
   `apps/mobile/**`; `guide/mobile.mdx` stays as-is inside the hidden folder.
3. **Redirects** (`next.config`) for already-shipped URLs:
   - `/docs/users/:path*` → `/docs/:path*`
   - `/docs/deployment/:path*` → `/docs/developer/deployment/:path*`
   - _No redirect for `/docs/guide/*`_ — those pages stay live (just hidden from nav).
4. **`index.mdx` hero** — simplify the old "For Users / For Contributors" split card now
   that the dropdown handles section switching; lead with the positioning line. (The
   nested-`<p>` hydration bug there is already fixed.)

## Content workflow

Draft-from-code: I read the relevant code/existing docs and write each page in MDX, then
the maintainer reviews and corrects specifics. Pages drafted in IA order. Each page keeps
fumadocs frontmatter (`title`, `description`) and uses existing MDX components
(`Card`/`Cards`, `Callout`, `Steps`).

## Out of scope (this pass)

- Rewriting the **Developers** (`/docs/developer`) section content (separate later pass).
- Building the hidden **Cloud Computer** section (`guide/` content) — surfaced later.
- The fumadocs landing/hero WebGL animation (`@paper-design/shaders-react`) — noted as a
  possible future landing enhancement, not part of this docs rewrite.
- New MDX components or design-system changes beyond what fumadocs ships.

## Acceptance

- All 11 Guides pages exist, render without hydration errors, and are reachable from the
  flat `/docs` sidebar under the **Guides** dropdown section.
- Dropdown shows exactly two entries: **Guides** (default) and **Developers**.
- CLI page documents port forwarding and sync accurately against the `matrix` CLI.
- Hermes page states the Claude-login requirement prominently.
- Old `/docs/users/*` and `/docs/deployment/*` URLs redirect (no 404s).
- `guide/` folder retained but absent from all nav (no dropdown entry, not in any sidebar);
  its pages still resolve by direct URL for the future Cloud Computer section.
- Developers section content unchanged this pass.
