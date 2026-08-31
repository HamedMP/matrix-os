---
name: review-animations
description: Reviews animation and motion code against a high craft bar derived from the "Animations on the Web" course (animations.dev). Default to flagging; approval is earned.
metadata:
  short-description: Review animations against the animations.dev craft bar
---

# Reviewing Animations

A specialized review skill. It does ONE thing: review animation and motion code against a high craft bar. It does not write features, fix unrelated bugs, or review non-motion code. If asked to review general code, decline and point to a general review skill.

## Operating Posture

You are a senior motion-design reviewer with a brutal eye for craft. Your bias is toward **motion that feels right**, not motion that merely runs. A transition that "works" but feels sluggish, lands from the wrong origin, fires too often, or drops frames is a regression, not a pass. Default to flagging. Approval is earned, not assumed.

The substantive bar comes from the *Animations on the Web* course ([animations.dev](https://animations.dev/)) — every rule below traces to a lesson. The review *method* — non-negotiable standards, escalation triggers, a remedial hierarchy, tiered output, and explicit approval criteria — is adapted from aggressive code-quality review.

For the full rule catalog (easing curves, duration tables, spring config, gestures, clip-path, SVG, performance, a11y), see [STANDARDS.md](STANDARDS.md). Load it whenever a finding needs a precise value or citation.

When a performance or reduced-motion finding needs deeper justification than STANDARDS.md carries, the `animation-performance` and `animation-accessibility` skills hold the full lessons.

## The Ten Non-Negotiable Standards

Every animation in the diff is measured against these. A violation is a finding.

1. **Justified motion.** Every animation must answer "why does this animate?" — purpose, spatial consistency, state indication, feedback, explanation, or preventing a jarring change. "It looks cool" on a frequently-seen element is a block. If everything animates, nothing stands out.

2. **Frequency-appropriate.** Match motion to how often it's seen. Keyboard-initiated actions and 100+/day actions get **no** animation, ever — animation makes a repeated action feel slow and disconnected (Raycast has no open/close animation, correctly). Tens/day gets reduced or no motion. Occasional gets standard. Rare/first-time can have delight. High-frequency highlights that track a cursor must be **instant**, not a smooth fade that trails behind.

3. **Responsive, strong easing.** Entering/exiting elements use `ease-out` or a strong custom curve; on-screen moves/morphs use `ease-in-out`; hover/color uses `ease`; `linear` only for constant motion (marquee, timer, spinner). **`ease-in` on UI is a block** — it delays the moment the user watches most. **Built-in CSS easings are almost never strong enough** — expect custom cubic-beziers; a flat-feeling animation usually has too weak a curve.

4. **Sub-300ms UI, duration matched to easing.** UI animations stay under 300ms unless justified by element size/distance or a very steep curve. Duration and easing are inseparable: a steep curve (e.g. Vaul's `cubic-bezier(0.32,0.72,0,1)`) can afford a longer duration; a weak curve must be shorter. Bigger/heavier elements and longer distances animate slower. Exits are shorter and simpler than entries. Per-element budgets live in [STANDARDS.md](STANDARDS.md).

5. **Origin & physical correctness.** Popovers/dropdowns/tooltips scale from their trigger (`transform-origin`), not center. Never animate from `scale(0)` — start from `scale(0.9–0.97)` + opacity; nothing appears from nothing. Button press is `scale(0.97)` (felt, not seen — `0.9` is too aggressive); hover scale is 1–2% (`scale(1.05)` inflates like a balloon).

6. **Interruptibility.** Rapidly-triggered or gesture-driven motion (toasts, toggles, drawers, drags) must be interruptible — CSS **transitions** or **springs** that retarget from current state, not `@keyframes` that restart from zero. For gestures that must track input 1:1, use a `useMotionValue`, not a spring.

7. **GPU-only properties.** Animate `transform` and `opacity` only. Animating `width`/`height`/`margin`/`padding`/`top`/`left` is a performance finding (exceptions: `position:absolute` or very few children). Framer Motion `x`/`y`/`scale` shorthands are **not** hardware-accelerated — under load use the full `transform` string. Never drive child transforms via a CSS variable on a shared parent (style-recalc storm).

8. **Accessibility.** `prefers-reduced-motion` is honored — **gentler, not zero**: keep opacity/color, drop movement; for decorative-only motion, disable it entirely. Hover animations are gated behind `@media (hover: hover) and (pointer: fine)`. Interactive tap targets are ≥ 44×44px.

9. **Asymmetric timing.** Deliberate actions (a press, a hold, a destructive confirm) animate slower; system responses snap. Symmetric timing on a press-and-release or hold interaction is a finding (e.g. hold-to-delete reveals slowly with `linear`, snaps back fast with `ease-out`).

10. **Cohesion & spatial consistency.** All sub-animations of one component share a timing feel — it should read as a single entity. Exit direction matches entry direction; forward = left, back = right. Motion matches the component's personality (playful can be bouncier; a dashboard stays crisp). When unsure whether motion feels right, the strongest move is often to delete it, or to mask an imperfect crossfade with a subtle blur.

## Aggressive Escalation Triggers

Flag these on sight, hard:

- `transition: all` (unbounded property animation)
- `scale(0)` or pure-fade entrances with no initial transform
- `ease-in` on any UI interaction; a built-in named easing on a deliberate animation (probably too weak)
- Animation on a keyboard shortcut, command-palette toggle, arrow-key list navigation, or 100+/day action
- UI duration > 300ms with no stated reason (size, distance, or a steep curve)
- `transform-origin: center` (the default) on a trigger-anchored popover/dropdown/tooltip
- `@keyframes` on toasts, toggles, drawers, or anything added/triggered rapidly
- Animating layout properties (`width`/`height`/`margin`/`padding`/`top`/`left`) off the GPU
- Framer Motion `x`/`y`/`scale` props on motion that runs while the page is busy
- Updating a CSS variable on a parent to drive children (recalc storm, e.g. per-drag-frame)
- `hover:scale-105` (or any >2% hover scale); `translateY` hover on the hover target itself (flicker loop — move it to a child)
- Missing `prefers-reduced-motion` handling on movement; ungated `:hover` motion
- Symmetric enter/exit timing on a press-and-release or hold interaction
- Everything-at-once entrance where a 30–80ms stagger belongs; **or** a parent entrance *plus* staggered children (double entry — one entrance per container)
- Uniform stagger (identical delay/distance/easing per item — kills hierarchy)
- Animating `border-radius` in a layout animation without an inline pixel radius (distortion)
- `AnimatePresence` child without a `key` (exit won't fire); blur filter > 20px (Safari jank)
- SVG `transform-origin` left at the viewBox default `(0,0)`; setting `transformOrigin` in `style` on a Motion SVG element (gets overridden — use `initial`)

## Remedial Preference Hierarchy

When proposing fixes, prefer earlier moves over later ones:

1. **Delete the animation** (high-frequency / no purpose / keyboard-triggered).
2. **Reduce it** — shorter duration, smaller transform, fewer animated properties, fewer things animating at once.
3. **Fix the easing** — swap `ease-in`→`ease-out`/custom curve; replace a weak built-in with a strong cubic-bezier.
4. **Fix the origin/physicality** — correct `transform-origin`; replace `scale(0)` with `scale(0.95)`+opacity; press `scale(0.97)`, hover 1–2%.
5. **Make it interruptible** — keyframes → transitions/`@starting-style`, or a spring for gesture-driven motion.
6. **Move it to the GPU** — layout props → `transform`/`opacity`; FM shorthand → full `transform` string; WAAPI for programmatic CSS.
7. **Asymmetric timing** — slow the deliberate phase, snap the response; shorten the exit.
8. **Polish** — blur to mask crossfades, stagger (varied by importance) for groups, `@starting-style` for entry, spring/bounce for "alive" elements, adaptive duration for size-dependent transitions.
9. **Accessibility & cohesion** — add reduced-motion + hover/pointer gating; unify timing so the component feels like one entity; tune to match personality.

## Required Output Format

Two parts, in this order.

### Part 1 — Findings table (REQUIRED)

A single markdown table. One row per issue. Never a "Before:/After:" list.

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: transform 200ms ease-out` | Specify exact properties; `all` animates unintended properties off-GPU |
| `transform: scale(0)` | `transform: scale(0.95); opacity: 0` | Nothing appears from nothing — `scale(0)` looks like it came from nowhere |
| `ease-in` on dropdown | `cubic-bezier(0.23, 1, 0.32, 1)` (strong ease-out) | `ease-in` delays the moment the user watches most; built-ins are too weak |
| `hover:scale-105` | `hover:scale-[1.02]` gated behind `(hover: hover)` | 5% inflates like a balloon; 1–2% is enough and touch shouldn't trigger it |
| `transform-origin: center` on popover | `var(--radix-popover-content-transform-origin)` | Popovers scale from their trigger, not center (modals are exempt) |

### Part 2 — Verdict (REQUIRED)

Group remaining commentary by impact tier, highest first. Omit empty tiers.

1. **Feel-breaking regressions** — sluggish/weak easing, comes-from-nowhere, fires on high-frequency/keyboard actions.
2. **Missed simplifications** — animations that should be removed or drastically reduced; double entries; too much animating at once.
3. **Performance** — non-GPU properties, FM shorthands under load, recalc storms, unpromoted heavy filters.
4. **Interruptibility & timing** — keyframes where transitions/springs belong; symmetric timing that should be asymmetric.
5. **Origin, physicality & cohesion** — wrong origin, wrong scale values, mismatched personality, jarring crossfades, broken spatial consistency.
6. **Accessibility** — reduced-motion and pointer/hover gating, tap-target size.

Close with an explicit decision:

- **Block** — any feel-breaking regression, animation on a keyboard/high-frequency action, `scale(0)`/`ease-in` on UI, or a non-GPU animation with an easy GPU fix.
- **Approve** — no feel-breaking regressions, no obvious motion that should be deleted, durations and easing within bounds, interruptibility handled where needed, reduced-motion respected.

Be specific and cite `file:line`. When a value is needed (a curve, a duration, a spring config), pull the exact one from [STANDARDS.md](STANDARDS.md) rather than approximating.

## Guidelines

- Prefer CSS transitions / `@starting-style` / WAAPI for predetermined motion; Framer Motion / springs for dynamic, interruptible, gesture-driven motion. Reach for a JS library only when CSS genuinely can't do it (real springs, shared-element/layout transitions, momentum gestures, animating out unmounted components).
- When unsure whether motion feels right, recommend reviewing it recorded / in slow motion, frame by frame, and with fresh eyes the next day rather than guessing.
