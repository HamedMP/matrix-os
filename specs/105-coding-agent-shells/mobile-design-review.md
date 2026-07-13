# Matrix OS Mobile — Design & UX Review

**Reviewer:** principal product designer (review-only)
**Scope:** `apps/mobile` (Expo, iOS-first) — every screen read in full
**Bar:** Cursor's iPhone app (calm near-white surfaces, one focal action, agent status as first-class UI)
**Brand anchor:** `packages/brand/` + `www/` landing (matrix-os.com) — "a computer in the cloud for your AI agents"
**Date:** 2026-07-13

---

## 1. Executive summary — the 5 highest style-per-effort changes

The app is not a hackathon demo. It has a genuinely mature token layer (`lib/theme.ts`), a legitimately excellent terminal surface, real haptics, well-written empty states, and one screen — the Apps launcher (`app/(tabs)/apps.tsx`) — that is already at the target quality bar. The problem is **inconsistency**: the newest screen uses the polished "botanical" token set (`paper/panel/ink/glow/display/shadows`), while the older screens (agents, files, computers, chat, settings) use a legacy shadcn-ish set (`background/card/foreground/primary`) and let color do almost no work. The result reads as two apps stitched together, and neither one is quite as warm as matrix-os.com.

The five changes with the best return:

1. **Warm the surface palette to match the website (S, `theme.ts` only).** The site is warm oat + cream (`pageBg #EEEEE2`, `card #FCFCF8`, `border #DCD9CC`); the app is cool near-white (`paper #FAFAF9`, `panel #FFFFFF`, `line #E7E9E3`). Retuning ~6 hex values instantly makes the whole app feel like the same product as the landing page. Single highest leverage move in the review.

2. **Ship one `StatusPill` primitive and wire it everywhere (M).** Cursor's signature is agent status as first-class UI (Working / Finished / N Active). Matrix already defines the exact tokens for this (`statusWaiting/Running/Idle/Done`, plus `success/warning/destructive/add/del`) — and **barely uses them**. Today a failed run, a running run, and a done run look identical (flat sage or raw enum text) on the thread, provider, terminal, and computer screens. Making color mean something is the single change that most closes the gap to Cursor while staying botanical.

3. **Fix the primary-button system (S/M).** The website's primary CTA is a deep near-black-forest pill (`deep #32352E`) with cream text. The app's primary is pale sage `primary #9AA48C` with a **mismatched ember drop-shadow** (`rgba(194,112,58,0.2)`) — low contrast and muddy (`app/index.tsx:269`, `sign-in.tsx:406`, `mission-control` FAB `:764`). Move primary → deep forest, demote sage to secondary/selected, reserve ember `#D06F25` as the single accent.

4. **Extract `Button` / `Card` / `StatusPill` primitives and adopt `paper/panel/ink` + the `type` scale app-wide (L, foundational).** There is a token kit but **no component kit** — buttons, cards, and pills are re-styled per screen and `STATUS_COLORS` is copy-pasted three times (`TaskCard.tsx:20`, `TaskDetail.tsx:15`, `ChannelBadge.tsx:10`). Extracting three primitives lets every legacy screen inherit apps.tsx quality and unblocks dark mode. Stage it screen-by-screen behind items 1–3.

5. **Redeem the launch / connect moment (M, signature).** Provisioning your own cloud computer — the emotional peak of onboarding — is currently a bare centered `ActivityIndicator` + one line of body text (`JourneyGate.tsx:122-129`), even though staged progress data (`journey.progress.stage`) is available. Turn it into a branded, staged reveal. This is the moment worth showing a friend.

Two near-free cleanups riding along: **wire or hide the Appearance theme toggle** (it saves `settings.theme` but nothing applies it — `settings.tsx:372`, `unistyles.ts:84` — so "Dark"/"System" do nothing today), and **humanize the machine strings** (raw ISO timestamps, `thread.id`, provider ids, `available - installed / authenticated`, `@@ -a,b +c,d @@`, byte counts) that leak across the agents surface.

---

## 2. Visual direction — fusing Cursor's calm with Matrix botanical

The target is not "make Matrix look like Cursor." It's: **take Cursor's discipline (calm surfaces, one focal action, status-as-UI, restrained motion) and express it in Matrix's warm botanical, owner-controlled voice.** Cursor is cool graphite-on-white; Matrix is warm forest-on-paper. Keep the warmth.

### 2.1 Color — warm the surfaces, let status carry the color

The one token both systems already share is **ember `#D06F25`** — keep it as the singular accent. Everything else should migrate toward the website's warmth.

| Role | Mobile today (`theme.ts`) | Website (`packages/brand/tokens.ts`) | Recommendation |
|---|---|---|---|
| App background | `paper #FAFAF9` (cool) | `pageBg #EEEEE2` (warm oat) | Warm to ~`#F4F2EA` (a middle ground; full `#EEEEE2` if you want to fully commit) |
| Card / panel | `panel #FFFFFF` (pure white) | `card #FCFCF8` (cream) | `#FCFCF8` — pure white is the #1 "generic SaaS" tell |
| Hairline border | `line #E7E9E3` (cool grey-green) | `border #DCD9CC` (warm taupe) | Warm to ~`#DCD9CC` |
| Muted text | `inkMuted #6B756B` | `mutedFg #5C5A4F` / `subtle #7A7768` | Warm slightly toward `#5C5A4F` |
| Ink / foreground | `ink #1A1D18` | `deep #32352E` | Keep `ink` for body; use `deep #32352E` for the primary button fill |
| Primary CTA | `primary #9AA48C` (pale sage) | `deep #32352E` w/ cream text | **Change:** deep forest pill, cream text |
| Accent | `glow #D06F25` (under-used) | `ember #D06F25` | Keep — make it the *only* accent (focus, attention dot, key highlight) |

**Sage `#9AA48C` demotes from "primary" to "secondary / selected."** It's a lovely calm tone but it's low-contrast as a button on near-white and it's doing the job the deep forest should. Selected chips, active filters, and toggles can stay sage; primary actions go deep.

### 2.2 Status-pill system (the load-bearing decision)

Define one tone set, back it with the existing tokens, and route **every** status through it. Model the shape on the website's `StatusPill` (radius `full`, tinted bg + solid fg — `packages/brand/src/primitives.tsx:60`):

| State | Fg token | Bg (tint of fg) | Where |
|---|---|---|---|
| Working / Running | `forest #323D2E` | `field`/forest 8% | agent running, terminal attached |
| Waiting / Needs you | `glow #D06F25` (ember) | ember 10% | approval pending, `payment_settling`, attention |
| Queued / Starting | `accentInk #4E6A4A` | forest 6% | run queued |
| Done / Ready | `#3B6D11` (website's green fg) or `add #3F7D4E` | green 8% | run complete, connected |
| Idle | `inkDim #9AA098` | line | dormant session |
| Error / Failed | `destructive #ef4444` | red 8% | failed run, offline |

Leading affordance: a **dot** for steady states, a **small spinner** for in-flight (`running`, `provisioning`, `connecting`). "N Active" counts (cockpit) use the ember tint. This one component, consistently applied, is what will make people say "it feels like Cursor."

### 2.3 Typography

The biggest brand-coherence gap after color: **the website's display face is Instrument Serif** (`brand/tokens.ts` → `fonts.display`), an elegant serif, while the app's display face is **Bricolage Grotesque** (`theme.ts:102`), a chunky grotesque. The two hero moments don't feel like the same brand.

- **Bring Instrument Serif into the app for hero moments only** — the landing/sign-in headline, the JourneyGate provisioning headline, and large empty-state headlines. Serifs are gorgeous at 28–40px and unmistakably Matrix; they're bad at 12–15px, so **do not** use it for UI. (If shipping another font weight is unwelcome, the fallback is to at least stop scaling Bricolage past 30px and accept the mismatch — but the serif is the right call and it's a small asset.)
- **Keep Inter for all UI** and JetBrains Mono for metadata/paths/section labels (the mono uppercase section label at `apps.tsx:734` and `settings.tsx:461` is a genuine brand signature — protect it).
- **Adopt the `type` scale (`theme.ts:125-135`) everywhere.** Right now every screen re-declares font sizes inline and the de-facto title size (24px Bricolage) matches no token (`h1` is 22, `display` is 30). Route titles through `type.display`/`type.h1` so hierarchy stops drifting per screen.

### 2.4 Card / radius / shadow / motion language

- **Radius:** standardize on `lg 12` (rows/inputs), `xl 16`–`xl2 20` (cards/sheets), `full` (pills). The app is already close; just make `borderCurve: "continuous"` (iOS squircle) **universal** — it's applied in apps.tsx/WindowHeader but missing on the Files and Computers cards, so corners visibly disagree.
- **Shadow:** use the forest-tinted `shadows.*` (`theme.ts:139-144`) — never plain black. Today only apps.tsx uses them; `GatewayCard.tsx:62` and `TaskCard.tsx:70` hardcode `rgba(0,0,0,0.04)`. For the calm look, prefer the website's very diffuse, no-offset shadow feel (`cardShadow = 0 0 7.5rem rgba(50,53,46,0.09)`) over tight drop-shadows.
- **Motion principles:** entrance fades that respect direction (ChatMessage's `FadeInLeft/Right` at `ChatMessage.tsx:47` is exactly right); press = `scale 0.97 + opacity` (apps.tsx grid cell at `:763` is the reference); status changes cross-fade rather than pop; **no bouncy springs** except the one place it earns delight (the connect moment). Add skeletons for the surfaces that currently flash a bare spinner. Keep motion quiet — calm is the brand.

---

## 3. Screen-by-screen findings (ranked, with fixes)

### Entry / auth

**`app/index.tsx` (landing)** — the first impression undersells the product.
- **Copy is generic dev-tool, not the brand voice.** "Your AI operating system / Native access to your shell, apps, channels, and agent kernel" (`:168-171`) vs the website's "A computer in the cloud for your AI agents." **Fix:** adopt the website's noun ("your cloud computer") and warmth.
- **Only a "Sign In" button** (`:176`), no "Get started." The website leads with "Get started." **Fix:** primary "Get started" (deep forest) + text "Sign in" secondary.
- **Primary button is pale sage with an ember shadow** (`:260-270`) — low contrast, muddy. **Fix:** deep-forest pill, cream text, drop the orange glow.
- Hero uses Bricolage at 36px (`:235`). **Fix:** Instrument Serif here.

**`app/sign-in.tsx`** — structurally the strongest auth screen; keep it.
- Good: "Computer URL" panel, `field`-filled inputs, cloud/self-hosted split, sensible keyboard handling. This already frames a *computer*, not a server.
- Google as a full sage-primary button with ember shadow (`:394-406`) inverts platform convention and repeats the muddy-shadow problem. **Fix:** neutral/white provider buttons; reserve the deep-forest primary for the single most-likely action.

**`components/JourneyGate.tsx`** — **the biggest missed moment in the app** (see §4).
- Every phase is a centered spinner + title + one line of body (`:122-129`). Provisioning your own computer deserves staged progress, brand, and delight.
- `title` uses `forest` and `body` uses `forest @ 0.8 opacity` (`:159-160`) — fine, but flat. **Fix:** see §4A.

### Tabs

**`app/(tabs)/apps.tsx` — the internal north star. Protect it; don't churn it.**
- Uses `paper/panel/field/ink/inkMuted/glow`, `display` at 34px, `shadows.card`, `glass.border`, squircle tiles, monogram fallbacks with gloss, "Jump back in" recent card, mono uppercase section labels. This is the quality bar the rest of the app should meet.
- Only nits: the top-right **avatar button has no `onPress`** (`:630`) — dead control; wire it to account/settings. Section label + grid spacing is the pattern to copy elsewhere.

**`app/(tabs)/chat.tsx`** — good bones, legacy tokens.
- Strong: animated typing indicator (reanimated, `:51`), "Try asking" suggestion chips as onboarding (`:449`), offline queue banner. Empty state follows the UX-guide pattern.
- Uses `background/card/border/primary` not `paper/panel/ink` — reads cooler/flatter than apps.tsx. Conversation bar buttons are 32px tall (`:507`, under 44). **Fix:** adopt the warm tokens; bump the pills.

**`app/(tabs)/terminal.tsx` + `WindowHeader` + `TerminalControlBar` — a genuine strength. Protect.**
- Full-bleed dark console, terminal-tone `WindowHeader` with double-tap maximize and compacting chrome, cursor-aware keyboard lift, detected-URL banner, session handoff/resume, expandable 6-row accessory keyboard with a variant/size system and a danger-styled Ctrl-C. This is the most polished, most "product" part of the app and shows real terminal-domain craft. **Do not refactor for consistency's sake** — instead, harvest its ideas (the `key()` variant factory, the tone system) into the shared primitives.
- One gap: the control-bar keys and the maximize gesture fire **no haptic** despite being the app's most tactile surface. **Fix:** add selection/impact haptics to keys and the maximize toggle.

**`app/(tabs)/settings.tsx`** — clean iOS grouped list; two problems.
- **The Appearance theme toggle is decorative** — `settings.theme` is saved (`:384`) but nothing calls `UnistylesRuntime.setTheme`/`setAdaptiveThemes` (`unistyles.ts:84` keeps `initialTheme:"light"`, adaptive commented out). Selecting Dark/System does nothing. **Fix:** wire it (dark mode is close — see §5) or hide it until dark ships. A control that lies is a trust tell.
- Section labels are sage mono on near-white — low contrast. Raw `systemInfo.version`/`model` strings (`:416-421`). Mobile also surfaces **Agent / Channels / Security** sections that the web shell hides for paid-beta (per repo `HIDDEN_SECTION_IDS`) — confirm that's intended on mobile.

### Agents (the surface most in need of love — see the detailed sub-report basis below)

**`app/agents/_layout.tsx`** — uses **default iOS `Stack` headers** with plain titles ("Agents", "New Run", "Agent Thread"), unlike the custom `WindowHeader` chrome everywhere else. Inconsistent nav identity. **Fix:** align to the app's header language.

**`components/agent-cockpit.tsx`** — second-best screen in the app after apps.tsx; the model for "agent status as UI."
- Strong focal quick-start CTA (forest bg, radius 20, `shadows.raised`, human copy "What do you want Matrix to build?", `:216`), `statusLabel` mapping running→"Working" (`:30`), "N working" / attention-count chips, hairline-divided thread rows (`:412`), relative-age formatting, selection haptics. **This is where the StatusPill and "N Active" system should crystallize, then propagate.**
- Nit: the per-project "+" is 28×28 (`:156`), under 44.

**`app/agents/[threadId].tsx`** — the "unfinished" concentration.
- **Status is bare `forest` text, not color-coded** (`:1086`) — running/failed/done look identical.
- **Inline error renders in `moss` green** (`:1153`) — an error styled as the calm brand green. Wrong; use `destructive`.
- Leaks raw machine data: ISO `updatedAt` (`:257`), raw `thread.id`, `terminalSessionId`, provider shown as **mono id** not display name, and timeline strings expose `event.outcome/requestId/status/decision` enums.
- No haptic on approve/decline/send (highest-stakes actions). **Fixes:** StatusPill on the header; `destructive` for errors; `formatRelativeAge` for timestamps (the cockpit already has it); friendly provider names; haptics on approve/decline.

**`app/agents/new.tsx` / `AgentComposerScreen.tsx`** — the composer is solid: proper segmented mode control (`:745`), 48px bottom-anchored Start CTA (the one primary that clears 44pt), real disabled states, good keyboard handling. **Add** a haptic on Start-run. Provider availability shows as capitalized subtitle text — convert to StatusPill.

**`app/agents/providers.tsx`** — clean notifications block, but auth status renders as **capitalized moss text** and setup rows show a raw `available - installed / authenticated` machine string (`:369`). **Fix:** StatusPill for auth state; human phrasing.

**`app/agents/reviews.tsx`** — the most dev-tool screen. Titles are raw `projectId` (`:652`), literal `@@ -a,b +c,d @@` hunk ranges (`:1181`), byte counts/etags, canned commit copy, text-only loading states (no spinner), 30px Save/Open buttons. **Fix:** friendly project names, hide/soften diff internals, StatusPill for review state, spinners on load, 44pt controls. Good bit to keep: high-severity finding counts already turn red (`:657`).

**`app/agents/terminals.tsx`** — session status is raw moss text; **unavailable sessions look identical to active ones** (`disabled` set but no visual state, `:99`). **Fix:** StatusPill + a real disabled treatment.

### Files & Computers

**`app/files.tsx` + `components/files/*`** — competent, legacy tokens, no page identity.
- No "Files" title/header — just breadcrumbs + search (`:365`). Friendly empty/unpreviewable copy (protect). Retry pill 40px (under 44). FileRow git-status pill uses `primary`/`secondary` with **no add/del color coding** despite `add`/`del` tokens existing. FileBreadcrumbs tap rows ~23px tall (`:59`). **Fixes:** add a page title in the warm/`display` style; color the git badges; warm the tokens.

**`app/computers.tsx` + `components/GatewayCard.tsx`** — **reads as a generic server inventory, not "your owned cloud computer."**
- Infrastructure language ("Choose computer / Switch **runtimes**", `server-outline`/`desktop-outline` icons, `@handle`, raw `versionLabel`, `gateway.url` IP:port in mono). Status pill renders the **raw availability enum, always colored sage** regardless of building/available (`:174,206`). Remove is a hidden long-press → `Alert`. Left-in `console.warn` (`:87`). Badge bg is hardcoded ember-ish with sage text (`GatewayCard.tsx:106`) — a mismatched warm-bg/cool-fg combo.
- **This is a signature surface** (choosing *your* computer) rendered as the blandest list in the app. **Fixes:** personal framing ("Your computers"), a hero card for the active machine (region/specs/uptime, not just handle/version), StatusPill with a **building spinner/pulse**, a haptic on selection, and warm tokens. Make it feel owned and alive.

**`components/ConnectionBanner.tsx`** — too quiet, and jargony.
- Offline is styled as calmly as connecting (`secondary` bg, `forest` text, `:28`) with **no red/amber escalation**; the "Connecting" icon is static (no spin); copy says "Chat **socket** offline" (`:16`) — developer jargon. **Fixes:** escalate offline to a `destructive`/`warning` tint, spin the connecting icon, and say "Reconnecting to your computer…".

---

## 4. Signature moments to invest in

Three-to-four interactions that make people show the app to a friend. Protect the two that already work; build the two that don't.

**A. The launch / connect moment (build — highest emotional payoff).**
Onboarding provisions *your own computer*. Today: a spinner (`JourneyGate.tsx`). Turn it into a staged reveal: a warm full-screen scene, Instrument-Serif headline in the brand voice ("Building your computer in the cloud"), a **stepped progress checklist** driven by the existing `journey.progress.stage` (allocating → installing → booting services → ready) with each step animating to a green check, ember as the active-step accent, and a satisfying "Your computer is ready" hand-off into the launcher. This is the "your agents in your pocket" story made physical.

**B. Agent status pills + "N Active" (build — the Cursor hallmark).**
The cockpit already coins "Working"/"N working." Promote it into the shared `StatusPill` and put it on the thread header, the agents list, notifications, and the tab-bar/app-icon badge. When someone opens the app to a botanical **"3 Active · 1 needs you"** and taps into a live "Working" run, that's the Cursor-parity beat — in Matrix's warm palette.

**C. Lock-screen / notification presence (build on existing wiring).**
`lib/push.ts` already routes `agent`/`task`/`cron`/`message`/`security` notifications (agent → `/agents/[threadId]`) and sets badges/banners. The design work is **rich, branded content**: "✅ Claude finished on `web-refactor`" / "⏸ Codex needs your approval," with actionable buttons (Approve / View) so work unblocks from the lock screen. This is the literal product promise ("stay in the loop, unblock from your phone") and it's mostly a content/notification-category design task, not new infra.

**D. The springboard + terminal attach (protect — already signature).**
The Apps launcher (warm squircles, "Jump back in," monogram fallbacks) and the terminal attach/resume (full-bleed console, cursor-aware lift, control bar) are already show-a-friend good. Don't refactor them into blandness in the name of consistency — instead, pull *their* warmth and craft into the shared kit.

---

## 5. Phased implementation plan

### Phase 1 — Polish (days). Warmth + color doing work. No structural change.
- **[S]** Retune surface tokens to the website's warmth (`lib/theme.ts`): `paper`→~`#F4F2EA`, `panel`→`#FCFCF8`, `line`→`#DCD9CC`, warm `inkMuted`. Ship dark values in the same pass so item below can flip.
- **[S]** Primary-button fix: deep-forest fill + cream text; drop ember shadows (`app/index.tsx:260`, `sign-in.tsx:394`, `mission-control.tsx:754` FAB).
- **[S]** Landing copy + Instrument-Serif hero (`app/index.tsx:168`); add "Get started."
- **[S]** Wire **or** hide the Appearance toggle (`settings.tsx:372` ↔ `unistyles.ts:79`).
- **[S]** Fix green error text → `destructive` (`app/agents/[threadId].tsx:1153`); escalate `ConnectionBanner` offline color + spin icon + de-jargon copy.
- **[S]** Humanize the worst machine strings: relative timestamps (reuse cockpit's `formatRelativeAge`), provider display names, drop raw `available - installed / authenticated` (`providers.tsx:369`), remove left-in `console.warn` (`computers.tsx:87`).
- **[S]** `borderCurve:"continuous"` on Files/Computers cards; forest-tinted `shadows.*` in place of hardcoded black (`GatewayCard.tsx:62`, `TaskCard.tsx:70`).

### Phase 2 — Structure (≈week). One kit, applied.
- **[M]** Extract `StatusPill` (tone set from §2.2) and delete the three duplicated `STATUS_COLORS` maps (`TaskCard.tsx:20`, `TaskDetail.tsx:15`, `ChannelBadge.tsx:10`).
- **[M]** Extract `Button` (primary/secondary/danger) and `Card` primitives; route apps.tsx's recipe through them.
- **[M]** Wire StatusPill through agents (`[threadId]` header, list, providers auth, terminals sessions), computers availability (with building spinner), tasks, cron, review state.
- **[M]** Migrate agents/files/computers/chat/settings from legacy tokens to `paper/panel/ink` + the `type` scale; add page titles in the warm `display` style where missing (Files, Computers).
- **[S]** Align `app/agents/_layout.tsx` nav chrome to the app's header language.
- **[S]** Bump sub-44pt controls (cockpit "+" `:156`, review Save/Open `:30`, breadcrumbs, chat conversation pills); add missing haptics (composer Start, approve/decline, terminal keys, computer select).
- **[M]** Complete dark mode: finish `colors.dark` botanical tokens, replace hardcoded white/black fills (`InputBar.tsx:97`, `ChatMessage` code bgs), then enable the settings toggle.

### Phase 3 — Signature (later). The show-a-friend beats.
- **[M]** JourneyGate staged provisioning reveal (§4A) — serif headline, stepped checklist off `journey.progress.stage`, ember active accent, ready hand-off.
- **[M]** Cockpit "N Active · N needs you" summary + tab-bar/app-icon badge (§4B).
- **[M]** Rich, actionable agent notifications (Approve/View from lock screen) on top of `lib/push.ts` (§4C).
- **[M]** Computers screen as an owned-computer hero (active machine card w/ region/specs/uptime, alive status) (§4D basis).
- **[S/M]** Quiet motion pass: cross-fade status changes, skeletons replacing bare spinners (files, reviews, thread), the one earned spring at connect.

---

## 6. Explicitly OUT — what NOT to copy from Cursor

- **Don't go cool/graphite.** Cursor is cool-neutral on white; copying that palette would erase Matrix's warm botanical identity. Keep forest/moss/ember/paper — warm, not clinical.
- **Don't frame it as a code editor / dev tool.** Cursor's story is "AI code editor." Matrix's is "your owned cloud computer" (OS + agents + apps + terminal, owner-controlled data). Keep computer/owner language ("your computer," "runs after your laptop closes"), not "workspace/IDE." This also means: don't strip the Apps launcher, Chat, or the non-coding surfaces to look like a pure coding-agent client — the breadth *is* the product.
- **Don't over-minimize to a single-purpose feed.** Cursor can be one focal action per screen because it does one thing. Matrix is an OS; preserve the launcher/tabs breadth. Apply Cursor's *focus discipline within* each screen, not Cursor's *scope*.
- **Don't chase heavy/animated marketing motion.** Keep motion calm and functional (status, entrance, connect). The brand is warm and quiet; flashy motion would fight it.
- **Don't adopt pure-white cards or a mono-accent graphite system** — that's the exact "generic SaaS" look the warm cream surfaces are meant to avoid.
- **Don't hide ownership behind "server/runtime" abstraction** even though it's technically accurate — that's the opposite of the "your computer" promise the whole review is trying to strengthen.

---

*Grounding: every claim cites a file/line read during this review. Strengths intentionally called out to protect (Apps launcher, terminal/WindowHeader/TerminalControlBar, cockpit quick-start, ChatMessage code blocks + haptics, empty-state copy) — the plan builds on them, it does not churn them.*
