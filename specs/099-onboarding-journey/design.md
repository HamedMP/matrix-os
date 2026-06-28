# 099 — Onboarding journey redesign (landing-aligned)

Status: Draft (parent design)
Date: 2026-06-28
Owner: hamedmp
Supersedes the narrow scope of `specs/098-onboarding-billing-preselect/` (folded in as Slice 2).

## Summary

Redesign the entire new-user journey to one calm editorial brand, anchored to
the marketing landing page as the **single source of truth**. The journey spine
(voice onboarding removed) is:

```
Sign-up → Sign-in → Billing → Provisioning → Canvas (dev mode)
                                              └─ Set up your workspace (non-blocking):
                                                 Connect agent → Connect GitHub → Clone/import repo
```

Delivered as three sequenced slices: **Foundation → Auth → Setup**.

Design was validated visually during brainstorming (brand style tile, sign-up
direction A, sign-in direction C, first-run canvas checklist, provisioning,
GitHub + clone step details). This doc is the written source of truth; each
slice has its own TDD plan.

## Brand source of truth

The landing's `www/src/components/landing/theme.ts` (palette/fonts/shadows) +
`primitives.tsx` (SectionCard, CtaButton, SectionTitle, PageHero) are the de
facto brand. Today there are **three divergent token systems**:

1. `www/src/components/landing/theme.ts` — master.
2. `shell/src/app/globals.css` CSS vars — match landing palette.
3. `shell/src/lib/onboarding-brand.ts` — **conflicting** (forest `#17281f`,
   ember `#d6653b`, an unused Orbitron font) used by the voice/sticker screens.

**Decision:** Extract one shared `@matrix-os/brand` package consumed by both
`www` and `shell`; retire `onboarding-brand.ts`. Canonical tokens:

| token | value |
|-------|-------|
| forest | `#434E3F` |
| forestDeep | `#2E3A2A` |
| deep | `#32352E` |
| cream | `#E0E1CA` |
| ember | `#D06F25` |
| pageBg | `#EEEEE2` |
| card | `#FCFCF8` |
| border | `#DCD9CC` |
| mutedFg | `#5C5A4F` |
| subtle | `#7A7768` |
| display font | Instrument Serif |
| body font | Instrument Sans |
| cardShadow | `0 0 7.5rem 0 rgba(50,53,46,0.09)` |

Button language (replaces ad-hoc solid-ember CTAs everywhere): **dark**
(`deep` bg, cream text), **outline** (`card`/`border`), **text** (forest +
arrow). Status pills: `connected` (forest-tint + green text), `pending`
(ember-tint). One repeated card surface: `card` bg, 1px `border`, soft shadow.

## Journey state machine alignment (non-negotiable)

`packages/platform/src/journey.ts :: deriveJourneyPhase` stays the authority.
Phases (`account_required → plan_required → payment_settling →
install_choices_required → provisioning → provisioning_failed → first_run →
ready`) are derived **server-side from real billing entitlement + machine
status**. The redesign is **presentation + UI intent only**:

- Plan preselect (Slice 2) is a UI default sourced from `publicMetadata`; it
  never advances or skips a phase. The `?plans=1` entrypoint is the URL the
  state machine itself emits.
- The setup checklist (Slice 3) renders at `first_run`/`ready` (post-machine).
  It is **non-blocking**: the canvas is live behind it; steps read/trigger
  existing capabilities but do not gate the journey.

## Per-screen design

### 1. Sign-up (www) — Direction A "product visual"
Two-column on cream. Left: wordmark → Instrument Serif headline ("A computer in
the cloud for your AI agents" / sign-up variant) → sub → a framed mini-workspace
visual (terminal + live agent status: Claude running, Codex PR opened, Hermes
idle). Right: "Matrix account / Secure session" eyebrow + a brand card wrapping
the Clerk `SignUp` form (social buttons, email/password, dark primary CTA).
Sells the product to new users.

### 2. Sign-in (www) — Direction C "editorial + roster"
Same frame, calmer. Left: big serif statement + a quiet agent chip row
(Claude · Codex · Cursor · Hermes) + "Welcome back" sub. Right: brand card with
Clerk `SignIn`. Returning users skip the pitch.

### 3. Billing (shell) — leave as-is
The plan-picker redesign is already finished in `BillingPanel.tsx`. **No visual
change.** Slice 2 only wires landing-label parity + plan preselect (spec 098).

### 4. Provisioning (shell `BootSequence`)
Calm progress: a 4-step rail (Account · Billing · Installs · Computer) with
done/active states, a serif phase title ("Building your Matrix computer"), a
quiet stage line, and a thin ember progress bar. Replace solid-ember CTA buttons
(`plan_required`, `provisioning_failed`) with the brand dark/outline buttons.

### 5. First-run canvas + "Set up your workspace" checklist (shell)
A brand card docked on the live first-run canvas. Header (serif title +
"explore anytime" sub + `N of 3` progress) and three expandable steps. Persists
until complete; offers "Skip for now". Replaces `ManualSetupStickers`.

### 6. Connect a coding agent (checklist step)
Rows for Claude Code / Codex / Hermes with live status from
`GET /api/agents/credentials/status`. "Connect" launches that agent's CLI login
(existing terminal-launch: `claude-login` / `codex-login`); Hermes is always-on.
**No paste-API-key flow** — the existing `ApiKeyInput` placeholder has no backend
and is retired.

### 7. Connect GitHub (checklist step)
Shows scopes (read/write repos, agent PRs, keys stay local) and an "Authorize
GitHub" action that triggers the existing `gh auth login --web` terminal launch.
Connected state ("@handle") reads from existing `GET /api/github/status`.

### 8. Clone or import a repo (checklist step) — new screen
Paste-URL input → Clone (existing `POST /api/projects` mode `github`); "pick from
GitHub" repo list (search + rows with language/stars) backed by **new**
`GET /api/github/repos`; "create an empty project" (existing mode `scratch`).
Cloned repos land under `$MATRIX_HOME/projects/<slug>/` (existing).

### 9. Top-bar mode switcher (shell) — distinguish Developer vs Canvas
Today `ModeSwitcher` (in the dock) always renders the same `MonitorIcon`, so
Developer and Canvas are indistinguishable at a glance. Replace it with a
**segmented control in the top bar** (`MenuBar`): one pill per visible mode
(Developer = terminal icon, Canvas = layout-grid icon), active pill raised in
brand colors, one click to switch. Add `icon` to `ModeConfig`
(`shell/src/stores/desktop-mode.ts`); **remove the dock mode button** (the
top-bar control is the single entry point).

## Backend reality (from investigation)

| Capability | Status | Endpoint/Path |
|-----------|--------|---------------|
| Agent status | exists | `GET /api/agents/credentials/status` |
| Agent verify | exists | `POST /api/agents/credentials/:agent/verify` |
| Agent CLI login | exists | `shell/src/lib/terminal-launch.ts` (`claude-login`, `codex-login`, `github-ssh-login`) |
| GitHub status | exists | `GET /api/github/status` → `{installed, authenticated, user, errorCode}` |
| GitHub authorize | exists | `gh auth login --web` via terminal launch |
| GitHub repos list | **new** | `GET /api/github/repos` (Slice 3) — back via `gh api user/repos` or Pipedream `list_repos` |
| Clone by URL | exists | `POST /api/projects` (`mode: "github"`) |
| Create empty project | exists | `POST /api/projects` (`mode: "scratch"`) |
| List projects | exists | `GET /api/workspace/projects` |
| Route registration | — | `packages/gateway/src/server.ts` (`createGateway`) |
| Auth/principal | — | `packages/gateway/src/request-principal.ts` (`requireRequestPrincipal`) |

**Net-new backend for the whole journey = one endpoint** (`GET /api/github/repos`).

## Slice breakdown

### Slice 1 — Brand foundation (`slice-1-brand-foundation/plan.md`)
Extract `@matrix-os/brand` (tokens + a small primitive set) consumed by www +
shell; retire `onboarding-brand.ts`; point `www` landing `theme.ts` and shell
token usages at the package (re-export to avoid a big rename churn). No
product-behavior change. **Dependency: none. Unblocks Slices 2 + 3.**

### Slice 2 — Auth + billing (`slice-2-auth-billing/plan.md`)
Absorbs `specs/098-onboarding-billing-preselect/plan.md` and adds the visual
redesign: sign-up (A) + sign-in (C) consuming the brand package; clickable
landing pricing rows; `/welcome` metadata handoff; shell `BillingPanel` plan
preselect from `publicMetadata`; landing↔Stripe label parity test. **Dependency:
Slice 1. Front-end only.**

### Slice 3 — Setup journey (`slice-3-setup-journey/plan.md`)
First-run canvas checklist replacing `ManualSetupStickers`; agent/GitHub/clone
steps wired to existing endpoints; `GET /api/github/repos` for the picker;
provisioning restyle; top-bar segmented mode switcher (Developer/Canvas with
distinct icons, dock control removed); retire `AgentCredentialPanel` ad-hoc
colors + the `ApiKeyInput` placeholder. **Dependency: Slice 1.**

## Cross-cutting requirements

**Security**
- `/welcome` (Slice 2): authenticated (`auth()` userId), plan validated against
  an allowlist, write failure caught + logged, never blocks redirect.
- `GET /api/github/repos` (Slice 3): authenticated via `requireRequestPrincipal`;
  `bodyLimit` N/A (GET) but apply per-route input validation (Zod) on
  pagination/search query params; outbound GitHub call uses
  `signal: AbortSignal.timeout(10_000)`; never echo provider/raw errors to the
  client (generic message, log server-side); if backed by `gh api`, run with a
  bounded timeout and sanitize stderr.
- Clone (`POST /api/projects`): existing endpoint; reuse its URL validation
  (`validateGitHubUrl`) and slug sanitization. No new attack surface.

**Resource management**
- No new unbounded maps/sets. Repo-list responses are paginated/capped.
- Slice 1 removes a `setInterval` (auth carousel) and dead styles.

**Error handling**
- Agent/GitHub status failures render a calm retry state, not a dead end.
- Clone failures surface a generic message + keep the step actionable.

**Testing (TDD)** — each slice plan front-loads failing tests. www specs use
source-text assertions (house style in `tests/www`); shell component tests use
jsdom + RTL (`tests/shell`); gateway route tests follow existing patterns.
React changes → `npx react-doctor@latest www|shell`. Screenshot evidence for
every user-visible screen.

**Delivery** — continue on the active onboarding branch (or a manual worktree
per repo hard rules); never commit to `main`; one PR per slice; size limits per
CLAUDE.md.

## Invariants

- **Source of truth (brand):** `@matrix-os/brand`, anchored to the landing.
- **Source of truth (journey):** `deriveJourneyPhase` (entitlement + machine).
  Redesign is presentation/UI-intent only; no phase is skipped or faked.
- **Source of truth (plan labels):** `MATRIX_BILLING_SERVER_PROFILES`, guarded
  by the parity test.
- **Non-blocking setup:** the checklist never gates the canvas; steps wire to
  existing capabilities.
- **Auth:** `/welcome` and `GET /api/github/repos` require an authenticated
  principal; anonymous never writes/lists.

## Out of scope (explicit)

- Voice onboarding, `VoiceWave`, `OnboardingScreen` voice mode — removed from
  the flow; not restyled.
- Paste-API-key agent flow (`ApiKeyInput`) — no backend; retired, not rebuilt.
- Billing picker visual redesign — already finished; untouched.
- Theme/wallpaper pickers, profile/goal screens — not part of this journey.
