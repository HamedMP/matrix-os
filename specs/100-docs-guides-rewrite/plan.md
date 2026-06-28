# Docs Guides Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the user-facing `/docs` ("Guides") section of `www` from scratch — 11 pages drafted from the actual codebase — positioned as a cloud coding computer for developers who run AI coding agents.

**Architecture:** fumadocs v16 docs in `www/content/docs/**`. Guides pages live flat at the `/docs` root; the Developers section is scoped under `/docs/developer`; the legacy `guide/` folder is retained but hidden (future "Cloud Computer" section). Section switching is a fumadocs sidebar root-toggle dropdown configured via explicit `sidebar.tabs` in `www/src/app/docs/layout.tsx`.

**Tech Stack:** Next.js 16, fumadocs-ui/fumadocs-mdx 16.x, MDX, Tailwind v4, lucide-react. Dev server: `bun run dev:www` on port 3001.

## Global Constraints

- Spec of record: `specs/100-docs-guides-rewrite/spec.md`.
- Every Guides page keeps fumadocs frontmatter: `title` + `description`.
- Use only existing MDX components: `Card`/`Cards` (`fumadocs-ui/components/card`), `Callout` (`fumadocs-ui/components/callout`), `Step`/`Steps` (`fumadocs-ui/components/steps`).
- **MDX nested-`<p>` rule:** never put block text on its own line inside a JSX `<p>` — keep `<p>…</p>` inline on one line, or use a non-`<p>` wrapper. This caused a hydration error already.
- No co-authored-by lines in commits. Conventional Commit messages.
- Draft-from-code: read the cited source files; the maintainer corrects specifics after.
- Do not modify the Developers (`/docs/developer`) section content or the hidden `guide/` content this pass.
- **Commits:** each task ends with a commit step, but per maintainer preference do not `git commit`/push until the maintainer has reviewed that task's render. Treat the commit step as "stage + await go-ahead."

## Standard verify-render recipe (referenced as "VERIFY <url>")

Run from `www/` with the dev server already up on :3001.

```bash
# 1. HTTP 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001<url>   # expect 200
```

Then via Playwright MCP (navigate to `http://localhost:3001<url>`) confirm:
- `document.querySelector('h1')` matches the page title.
- `document.querySelectorAll('p p').length === 0` (no nested-`<p>` hydration error).
- For Guides pages: the page link appears in `#nd-sidebar` under the **Guides** dropdown.

---

## Task 1: Section labels (Guides / Developers)

**Files:**
- Modify: `www/src/app/docs/layout.tsx` (the `sidebar.tabs` array)
- Modify: `www/content/docs/developer/meta.json` (`title`)

**Interfaces:**
- Produces: dropdown with exactly two entries — `Guides` (`/docs`, default) and `Developers` (`/docs/developer`).

- [ ] **Step 1: Set the tab titles** in `layout.tsx` `sidebar.tabs` to:

```tsx
tabs: [
  {
    title: 'Guides',
    description: 'Use your cloud coding computer',
    url: '/docs',
    icon: <Rocket className='size-4' />,
  },
  {
    title: 'Developers',
    description: 'Build & operate Matrix OS',
    url: '/docs/developer',
    icon: <Terminal className='size-4' />,
  },
],
```

- [ ] **Step 2: Align the section meta title.** In `www/content/docs/developer/meta.json` set `"title": "Developers"`.

- [ ] **Step 3: VERIFY `/docs`** — then assert the dropdown menu has exactly 2 `<a>` items (`Guides` → `/docs`, `Developers` → `/docs/developer`) and the `guide/` folder produces no dropdown entry.

- [ ] **Step 4: Stage & await go-ahead.**

```bash
git add www/src/app/docs/layout.tsx www/content/docs/developer/meta.json
# commit on maintainer go-ahead:
# git commit -m "feat(docs): label sidebar sections Guides / Developers"
```

---

## Task 2: Redirects for moved URLs

**Files:**
- Modify: `www/next.config.*` (add an `async redirects()`); if one exists, extend it.

**Interfaces:**
- Produces: 308 redirects so old links don't 404.

- [ ] **Step 1: Read** `www/next.config.*` to see if `redirects()` already exists and the export shape (CJS/ESM).

- [ ] **Step 2: Add redirects** (merge into existing array if present):

```ts
async redirects() {
  return [
    { source: '/docs/users/:path*', destination: '/docs/:path*', permanent: true },
    { source: '/docs/users', destination: '/docs', permanent: true },
    { source: '/docs/deployment/:path*', destination: '/docs/developer/deployment/:path*', permanent: true },
    { source: '/docs/deployment', destination: '/docs/developer/deployment', permanent: true },
  ];
},
```

- [ ] **Step 3: Verify** (redirects need a server restart to take effect):

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3001/docs/users/quickstart   # expect 308 -> /docs/quickstart
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3001/docs/deployment/vps-per-user  # expect 308 -> /docs/developer/deployment/vps-per-user
```

- [ ] **Step 4: Stage & await go-ahead.**

```bash
git add www/next.config.*
# git commit -m "feat(docs): redirect legacy /docs/users and /docs/deployment URLs"
```

---

## Task 3: About (index)

**Files:**
- Modify: `www/content/docs/index.mdx`

**Source to read:** existing `index.mdx`, `specs/web4-vision.md`, root `CLAUDE.md` (positioning).

- [ ] **Step 1: Rewrite** with frontmatter `title: "Matrix OS"`, `description: "Your cloud coding computer for developers who run AI coding agents."` Lead section: the positioning line + the persistent-workspace mental model + the four surfaces (web shell, CLI, mobile, desktop). Simplify the existing hero split-card (the dropdown now handles section switching). Keep `Cards` linking to Quickstart, CLI, Coding Agents, Hermes. Obey the inline-`<p>` rule.

- [ ] **Step 2: VERIFY `/docs`** (h1 "Matrix OS", zero nested `<p>`).

- [ ] **Step 3: Stage & await go-ahead.** `git add www/content/docs/index.mdx`

---

## Task 4: Quickstart

**Files:**
- Modify: `www/content/docs/quickstart.mdx`

**Source to read:** existing `quickstart.mdx`, onboarding flow (`shell/` sign-up/welcome, `packages/platform` provisioning), `specs/098-onboarding-billing-preselect`.

- [ ] **Step 1: Rewrite** using `Steps`/`Step`: sign up → choose compute power & region → pay → provision the Matrix computer → land in the web shell. Cross-link CLI + Web Shell. Frontmatter `title: "Quickstart"`.

- [ ] **Step 2: VERIFY `/docs/quickstart`.**

- [ ] **Step 3: Stage & await go-ahead.** `git add www/content/docs/quickstart.mdx`

---

## Task 5: CLI (sync + port forwarding)

**Files:**
- Modify: `www/content/docs/cli.mdx`

**Source to read:** `packages/sync-client/src/cli/commands/*` — especially `login.ts`, `run.ts`, `shell.ts`, `sync.ts`, `upload.ts`, `download.ts`, `port.ts`, `status.ts`, `whoami.ts`, `doctor.ts`; and `port-forward.ts`.

- [ ] **Step 1: Rewrite.** Sections: Install; `matrix login` (device flow; `--dev`/`--profile local` for local); `matrix run -it -- claude`; `matrix shell connect -c <session>` (create-if-missing); **file sync** (`sync`/`upload`/`download`); **port forwarding** — `matrix port forward` (and the `matrix forward` alias): "Forward a local loopback port to the Matrix computer", document local/remote host:port; `status` / `whoami` / `doctor`. Include the `gh auth login` inside a session note **with the SSH-key passphrase Callout** (see Task 6 callout text). Frontmatter `title: "CLI"`.

- [ ] **Step 2: VERIFY `/docs/cli`** and confirm the page text contains "port forward" and "sync".

- [ ] **Step 3: Stage & await go-ahead.** `git add www/content/docs/cli.mdx`

---

## Task 6: Web Shell (with SSH-key passphrase callout)

**Files:**
- Modify: `www/content/docs/shell.mdx`

**Source to read:** shell terminal code (`shell/src/components/terminal/*`), CLAUDE.md "Shell Gotchas", zellij session model.

- [ ] **Step 1: Rewrite.** Sections: the web shell overview; Terminal + zellij named sessions; **GitHub auth** via `gh auth login` inside a session; file browser. Frontmatter `title: "Web Shell"`.

- [ ] **Step 2: Add the required Callout** in the GitHub auth section, verbatim intent:

```mdx
<Callout type="warn" title="Set a passphrase for your SSH key">
  When `gh auth login` generates an SSH key in the shell, choose a password
  (passphrase) for it — don't leave it empty. The key lives on your Matrix
  computer; a passphrase keeps it protected.
</Callout>
```

- [ ] **Step 3: VERIFY `/docs/shell`** and confirm the page text contains "passphrase".

- [ ] **Step 4: Stage & await go-ahead.** `git add www/content/docs/shell.mdx`

---

## Task 7: Coding Agents

**Files:**
- Modify: `www/content/docs/coding-agents.mdx`

**Source to read:** `packages/platform/src/developer-tools.ts`, `shell/src/components/terminal/TerminalApp.tsx`, CLAUDE.md "Terminal agent installs" + "Agent CLI matrix".

- [ ] **Step 1: Rewrite.** Which agents are supported (Claude, Codex, Pi, OpenCode); installing one from the Terminal `+` menu (`npm i -g --prefix "$MATRIX_NODE_PREFIX"`, default `/opt/matrix/runtime/node`); how installs surface. Link to Hermes for the chat agent. Frontmatter `title: "Coding Agents"`.

- [ ] **Step 2: VERIFY `/docs/coding-agents`.**

- [ ] **Step 3: Stage & await go-ahead.** `git add www/content/docs/coding-agents.mdx`

---

## Task 8: Hermes (Chat) — Claude login requirement

**Files:**
- Modify: `www/content/docs/hermes.mdx`

**Source to read:** `packages/gateway/src/messages/hermes-capability.ts`, `hermes-delivery.ts`, `hermes` references in `packages/kernel/src`.

- [ ] **Step 1: Rewrite.** What Hermes is (always-on chat agent); **prominent Callout at the top: Hermes requires a Claude login to operate** — what works / what's gated without it, and how to connect it. Frontmatter `title: "Hermes"`.

```mdx
<Callout type="warn" title="Hermes needs a Claude login">
  Hermes runs on Claude. Connect your Claude login before using it — without it,
  chat responses are unavailable. [How to connect](/docs/coding-agents)
</Callout>
```

- [ ] **Step 2: VERIFY `/docs/hermes`** and confirm the page text contains "Claude login".

- [ ] **Step 3: Stage & await go-ahead.** `git add www/content/docs/hermes.mdx`

---

## Task 9: Matrix Skills (trim)

**Files:**
- Modify: `www/content/docs/matrix-skills.mdx`

**Source to read:** existing page, `skills/matrix/`, CLAUDE.md "Canonical Matrix skill pack".

- [ ] **Step 1: Trim & align** to the current canonical pack and sync story; drop stale detail. Frontmatter `title: "Matrix Skills"`.

- [ ] **Step 2: VERIFY `/docs/matrix-skills`.**

- [ ] **Step 3: Stage & await go-ahead.** `git add www/content/docs/matrix-skills.mdx`

---

## Task 10: Mobile (new)

**Files:**
- Create: `www/content/docs/mobile.mdx`
- Modify: `www/content/docs/meta.json` (insert `"mobile"` after `"matrix-skills"`)

**Source to read:** `apps/mobile/**` (terminal screen, sessions, control bar), `docs/dev/mobile-shell.md`, hidden `guide/mobile.mdx` for salvage.

- [ ] **Step 1: Create** the page: the mobile shell/app, the mobile terminal view, attaching to sessions from mobile. Frontmatter `title: "Mobile"`, `description`.

- [ ] **Step 2: Add `"mobile"`** to `www/content/docs/meta.json` pages array (after `"matrix-skills"`).

- [ ] **Step 3: VERIFY `/docs/mobile`** and confirm it appears in the Guides sidebar.

- [ ] **Step 4: Stage & await go-ahead.** `git add www/content/docs/mobile.mdx www/content/docs/meta.json`

---

## Task 11: Messages (light edit)

**Files:**
- Modify: `www/content/docs/messages.mdx`

**Source to read:** existing page, `packages/gateway/src/messages/`, `specs/077-matrix-messaging-bridge`.

- [ ] **Step 1: Light edit** for accuracy + voice. Frontmatter `title: "Messages"`.

- [ ] **Step 2: VERIFY `/docs/messages`.**

- [ ] **Step 3: Stage & await go-ahead.** `git add www/content/docs/messages.mdx`

---

## Task 12: Desktop App (light edit)

**Files:**
- Modify: `www/content/docs/desktop.mdx`

**Source to read:** existing page, `desktop/` (Operator), CLAUDE.md "Desktop Release Workflow".

- [ ] **Step 1: Light edit** for accuracy + voice. Frontmatter `title: "Desktop App (Operator)"`.

- [ ] **Step 2: VERIFY `/docs/desktop`.**

- [ ] **Step 3: Stage & await go-ahead.** `git add www/content/docs/desktop.mdx`

---

## Task 13: Settings & Billing

**Files:**
- Modify: `www/content/docs/settings-billing.mdx`

**Source to read:** existing page, `shell/src/components/settings/sections/BillingPanel.tsx`, `specs/098-onboarding-billing-preselect`.

- [ ] **Step 1: Align** to current plan/compute/region/billing UI. Frontmatter `title: "Settings & Billing"`.

- [ ] **Step 2: VERIFY `/docs/settings-billing`.**

- [ ] **Step 3: Stage & await go-ahead.** `git add www/content/docs/settings-billing.mdx`

---

## Task 14: Final sweep

**Files:** none (verification only).

- [ ] **Step 1: All Guides routes 200** (restart `bun run dev:www` first so redirects + `.source` are fresh):

```bash
for p in docs docs/quickstart docs/cli docs/shell docs/coding-agents docs/hermes \
         docs/matrix-skills docs/mobile docs/messages docs/desktop docs/settings-billing; do
  echo "$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/$p)  /$p"
done
```

- [ ] **Step 2: Dropdown = exactly Guides + Developers**; `guide/` absent from all nav; `/docs/guide` still 200 by direct URL.

- [ ] **Step 3: Redirects** — `/docs/users/quickstart` → `/docs/quickstart`; `/docs/deployment/vps-per-user` → `/docs/developer/deployment/vps-per-user`.

- [ ] **Step 4: Zero nested `<p>`** across all Guides pages (Playwright sweep).

- [ ] **Step 5: react-doctor** on the layout change (React files touched):

```bash
npx react-doctor@latest www
```

- [ ] **Step 6: Stage remaining & await go-ahead** for a final docs commit.

---

## Self-Review

- **Spec coverage:** positioning (Task 3), Guides/Developers labels (Task 1), 11 pages (Tasks 3–13), CLI port-forward+sync (Task 5), Hermes Claude-login callout (Task 8), SSH passphrase callout (Tasks 5+6), Mobile new page (Task 10), `guide/` kept-hidden (Task 1 verify + Task 14 step 2), redirects (Task 2/14). Covered.
- **Placeholders:** none — each task names exact files, source-to-read, outline, required callout text, and a verify command.
- **Consistency:** `sidebar.tabs` titles (Guides/Developers) used consistently; meta title aligned in Task 1; VERIFY recipe defined once and referenced.
