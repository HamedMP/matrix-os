---
name: animate
description: Design and build web animations that feel right, grounded in the complete "Animations on the Web" course (animations.dev). Use proactively whenever building or improving motion — deciding whether to animate, choosing easing/duration/springs, implementing entrances, exits, hovers, gestures, drawers, popovers, morphs, layout and shared-element transitions, SVG animation, or fixing motion that feels janky, sluggish, or off. Triggers on — animate, animation, motion, easing, ease-out, ease-in-out, cubic-bezier, duration, spring, bounce, keyframes, transition, transform, opacity, scale, translate, clip-path, stagger, hover, press, drag, gesture, drawer, popover, dropdown, tooltip, modal, toast, morph, crossfade, shared element, layout animation, Framer Motion, motion/react, AnimatePresence, layoutId, WAAPI, SVG animation, stroke-dashoffset, prefers-reduced-motion, will-change, GPU, "feels janky", "make it smooth", "feels off".
metadata:
  short-description: Design and build web animations that feel right (animations.dev course)
---

# Building Animations

The complete builder's guide to motion that feels right, distilled from Emil Kowalski's *Animations on the Web* course ([animations.dev](https://animations.dev/)). Use it to make decisions first, then implement.

## Initial Response

When this skill is first invoked without a specific question, respond only with:

> I'm ready to help you build animations that feel right, based on Emil Kowalski's animations.dev course. Tell me what you're animating.

Do not provide any other information until the user asks a question.

## Core Philosophy

An animation feels right when it satisfies three things at once:

1. **It feels natural.** It mirrors the physics of the real world. Nothing around us moves at a constant speed or appears out of nowhere — so `linear` easing feels lifeless and `scale(0)` entrances feel wrong.
2. **It has a purpose.** You can answer "why does this animate?" in one sentence, and neither you nor the user is surprised or annoyed by it.
3. **It's made with taste.** Taste is trained, not innate — the ability to tell good motion from bad and justify why. In a world where everyone's software works, taste is the differentiator.

Two consequences run through everything below:

- **Unseen details compound.** Most motion details users never consciously notice — that's the point. The aggregate of invisible correctness is what makes an interface feel expensive.
- **If everything animates, nothing stands out.** Motion is a spice, not the meal. Pace it through the experience; the more you add, the less each one is worth.

## Load These When Implementing

This file is the decision layer. When you move to code, load the companion reference for the exact recipe:

- **[css-techniques.md](css-techniques.md)** — transitions vs keyframes, transforms, `clip-path`, `@starting-style`, stagger, hover patterns, 3D.
- **[framer-motion.md](framer-motion.md)** — `motion/react`: `initial`/`animate`/`exit`, spring configs, `AnimatePresence` modes, `layout`/`layoutId`, motion values & hooks, animating height, and the component recipes (drawer, crossfade, morph, shared-element, trash).
- **[svg-animation.md](svg-animation.md)** — `viewBox`, line-drawing (`stroke-dashoffset`), `transform-box`/origin, path morphing, shakes, ambient "life."

Err on the side of loading a reference rather than approximating a value.

## The Animation Decision Framework

Answer these in order **before** writing animation code.

### 1. Should this animate at all?

Match motion to how often the user sees it:

| Frequency | Decision |
| --- | --- |
| 100+/day (keyboard shortcuts, command-palette toggle, arrow-key list nav) | **No animation. Ever.** |
| Tens/day (hover effects, list navigation) | Remove or drastically reduce |
| Occasional (modals, drawers, toasts) | Standard animation |
| Rare / first-time (onboarding, feedback, celebrations) | Can add delight |

**Never animate keyboard-initiated actions** — they repeat hundreds of times a day; animation makes them feel slow and disconnected. Raycast has no open/close animation — that's correct for something opened hundreds of times a day. A high-frequency selection highlight should be **instant** (track the cursor exactly), not a smooth fade that trails one step behind.

### 2. What's the purpose?

Every animation needs one of: **explanation** (marketing/onboarding), **feedback/responsiveness** (a button that reacts to a press), **spatial consistency** (an element enters and exits the same way), **state indication**, **preventing a jarring change** (a toast that eases in instead of popping), or — rarely — **delight** (reserved for interactions seen seldom, so it stays a pleasant surprise). "It looks cool" on a frequently-seen element is not a purpose.

### 3. Then pick the ingredients

Easing → duration → physicality → (spring?) → interruptibility → performance → accessibility. The rest of this file is those ingredients.

## Easing

Easing is the single most important part of an animation — it can make a bad animation look great or a great one feel wrong.

| Situation | Curve |
| --- | --- |
| Entering or exiting the screen | **`ease-out`** (fast start, gentle settle — feels responsive) |
| Moving / morphing while already on screen | **`ease-in-out`** (car accelerating then braking) |
| Hover / color / background / opacity | **`ease`** (asymmetric, elegant for small changes; CSS default) |
| Constant motion (marquee, spinner, timer, hold-to-delete) | **`linear`** |
| Default | **`ease-out`** |

**Never use `ease-in` on UI.** It starts slow — delaying the exact moment the user is watching — then accelerates into the stop, the opposite of how things settle.

**Built-in named curves are almost never strong enough.** Their acceleration is too weak, so animations feel flat. Every course example uses a **custom** curve. Prefer **asymmetric** curves (steep start, slow settle) — they feel alive and mimic a spring without one. When an animation feels flat, the curve is probably too weak, not the duration.

Curves worth reaching for:

```css
--ease-out-expo:      cubic-bezier(0.19, 1, 0.22, 1);        /* strong ease-out: hovers, reveals */
--ease-out-quad:      cubic-bezier(0.25, 0.46, 0.45, 0.94);  /* button press */
--ease-in-out-cubic:  cubic-bezier(0.645, 0.045, 0.355, 1);  /* on-screen back-and-forth */
--ease-vaul:          cubic-bezier(0.32, 0.72, 0, 1);        /* iOS sheet — extremely steep start */
--ease-drawer-height: cubic-bezier(0.25, 1, 0.5, 1);         /* snappy height change */
```

**Pair entering and exiting elements to the same direction and curve family** so the interaction reads as one coherent space.

## Duration

Keep UI animations **under ~300ms** unless justified. A 180ms dropdown feels more responsive than a 400ms one. Faster spinners make loads *feel* faster.

| Element | Duration |
| --- | --- |
| Button press | ~150ms |
| Tooltips, small popovers | 125–200ms |
| Dropdowns, selects | 150–250ms |
| Modals, drawers | 200–500ms |
| Small floating drawer | ~270ms |
| Wide menu resize | ~250ms |
| Big element crossing the screen | up to ~1s |

**Duration and easing are inseparable.** A steep curve can afford a longer duration (Vaul's 500ms doesn't feel slow because the curve front-loads the movement); a weak curve must be shorter. **Choose the easing first, then tune duration to it.** Duration scales with **element size and travel distance** (a bigger element is heavier). **Exits are shorter and simpler than entries** — the user already decided; get out of the way. Too fast is as bad as too slow. Marketing pages can run longer; product must feel fast.

For transitions whose size varies (an auto-height drawer), make duration **proportional to how much changed** so small changes don't over-animate — see the adaptive-duration recipe in [framer-motion.md](framer-motion.md).

## Physicality

- **Never animate from `scale(0)`.** Start entrances from `scale(0.9–0.95)` + `opacity: 0`. Nothing appears from nothing; a near-full start reads as "it was always almost there." Bigger floating elements start closer to 1 (a nav menu uses `scale(0.98)`).
- **Button press:** `transform: scale(0.97)` on `:active`, `transition: transform ~150ms`. Press feedback is *felt, not seen* — `scale(0.9)` visibly collapses. Buttons feel best with **both** hover and press feedback; hover with nothing on click feels dead.
- **Hover scale:** 1–2% is plenty (`scale(1.02)`). `hover:scale-105` inflates like a balloon. Hover duration 100–150ms.
- **Origin-aware popovers.** Scale from the **trigger**, not the center (the CSS default `transform-origin: center` is wrong for almost every triggered element). Use the library's variable:
  ```css
  .popover { transform-origin: var(--radix-popover-content-transform-origin); } /* Radix */
  .popover { transform-origin: var(--transform-origin); }                       /* Base UI */
  .menu    { transform-origin: top center; }                                    /* trigger above */
  ```
  **Modals are exempt** — they appear centered, keep `transform-origin: center`.
- **Never put a hover lift on the hover target itself.** Animating `translateY` on the hovered element moves it out from under the cursor → hover ends → it drops → flicker loop. Move the lift to an inner child; the parent stays under the cursor.

## Springs

Springs simulate physics (mass, stiffness/tension, damping) with no fixed duration, so they feel organic and alive. Reach for them for: drag with momentum, "alive" elements (Dynamic Island), interruptible gestures, and cursor-following. Simple color/opacity changes don't need a spring. Real springs are impossible in pure CSS (only approximable with `linear()`).

```js
// Apple / Motion style (easier to reason about) — great for UI text/state swaps
{ type: "spring", duration: 0.3, bounce: 0 }
{ type: "spring", duration: 0.5, bounce: 0.2 }
// Physics form (more control)
{ type: "spring", stiffness: 100, damping: 10, mass: 0.75 }
```

- **Default bounce to 0.** No overshoot keeps UI natural and elegant. Add bounce only intentionally — a slight bounce at the *end of a drag* (a drag applies force); a press-to-close gets none. Bounce is personality: more = playful, zero = serious.
- **Bounce scales inversely with element size** — smaller elements need *more* bounce to read the same amount.
- **Springs are interruptible** — redirected mid-motion, they carry velocity, so gestures the user reverses stay smooth. This is why the Sonner toast bug (new toast jumping) was a keyframe/interruptibility problem.
- **"Weird" spring motion is usually fixed by increasing `damping`.**

## Interruptibility

Anything triggered rapidly (toasts, toggles, drawers, accordions, drags) must animate **from its current state**, not restart. CSS **transitions** and **springs** are interruptible; `@keyframes` restart from zero and make new items jump. Prefer transitions/springs for dynamic UI, and `@keyframes` only for autonomous, looping, or one-shot motion. Use `@starting-style` to animate an enter without JS — see [css-techniques.md](css-techniques.md).

## Performance

**The golden rule: only animate `transform` and `opacity`.** They run on the GPU (Composite step only). `width`/`height`/`margin`/`padding`/`top`/`left` trigger Layout + Paint + Composite and drop frames. Prefer `transform: translate` (percentages — relative to the element's own size) over `margin`/`top`, and `scale` over animating dimensions. Target 60fps (≤16.7ms/frame).

- **Framer Motion `x`/`y`/`scale` shorthands are not hardware-accelerated** — they run on the main thread via rAF. When motion must stay smooth under load, animate the full `transform` string.
- **Don't drive child transforms through a CSS variable on a shared parent** — inherited vars recalc styles for all descendants (the Vaul lag past ~20 items). Set `transform` directly on the element.
- **CSS/WAAPI beat JS under load** — they run off the main thread. Use CSS for predetermined motion, JS for dynamic/interruptible.
- **`will-change: transform`** fixes 1px GPU/CPU shift and promotes heavy/filtered elements to their own layer — but add it (and `contain: layout style paint`, `translateZ(0)`) **only once you see dropped frames**; too many layers cost memory.
- **Keep animated `blur()` ≤ ~20px** — blur gets laggy fast, especially in Safari.

For the full frame-budget model (the Layout/Paint/Composite pipeline, main-thread vs GPU, React re-renders, and a diagnosis checklist for dropped frames), use the `animation-performance` skill.

## Stagger, hierarchy & orchestration

Stagger group entrances 30–80ms apart — longer feels slow, and stagger is decorative so it must never block interaction. **Vary the delay and distance by visual importance**: the most important element appears first with the most screen time; the least important can just fade in without sliding. **Uniform stagger** (identical delay/distance/easing per item) kills hierarchy and feels artificial.

**One entrance per container.** Don't slide a panel in *and* trickle its children in — slide it in with content already there. Sometimes the best animation is no animation.

## Cohesion & spatial consistency

- All of a component's sub-animations should share a timing feel so it reads as a **single entity** (the Family Drawer overrides Vaul's 500ms to 200ms so opening and height changes feel unified).
- **Exit direction matches entry direction**; navigation maps **forward = left, back = right**. A zoomed view expands from its thumbnail (object permanence) — it doesn't fade in from nowhere.
- Match motion to the component's **personality** — playful can be bouncier; a dashboard stays crisp (Sonner uses `ease`, slightly slower, to feel elegant).
- Prefer a **crossfade with a subtle directional hint** (8px shift + opacity + light blur) over a heavy full slide for small, structurally-similar content.
- When a crossfade shows two overlapping states despite tuning, add a subtle **`filter: blur(2px)`** during the transition to blend them into one perceived transformation.

## Accessibility

**Reduced motion means gentler, not zero.** Keep transitions that aid comprehension (opacity/color); remove movement and position changes. For purely decorative motion, disable it entirely (a lingering float would falsely imply interactivity).

```css
@media (prefers-reduced-motion: reduce) {
  .element { animation: fade 0.2s ease; } /* replace movement, don't just delete */
}
@media (hover: hover) and (pointer: fine) {
  .element:hover { transform: scale(1.02); } /* gate hover — touch fires false hovers on tap */
}
```

In Framer Motion, `useReducedMotion()` branches values, and `<MotionConfig reducedMotion="user">` animates only opacity/background app-wide. Make tap targets **≥ 44×44px** (enlarge with an invisible `::before` hitbox). On touch, hover+click fire together — detect `pointer: coarse` and use a two-tap pattern (first tap = hover, second = click).

For the two-variant workflow and the recipes for autoplaying media, looping animation, and smooth scrolling, use the `animation-accessibility` skill.

## Process

Great animations take iteration, not one sitting.

- **Record and scrub** the reference (and your own work) frame by frame; tune magic transform values live in the console.
- **Don't code and ship in one sitting** — review with fresh eyes the next day (Sonner's transitions were replayed and tweaked daily for days).
- **Test gestures on real devices** (hit the dev server by IP; opacity-heavy motion wants high-refresh screens).
- Steal like an artist: recreate great animations by studying proven products rather than inventing patterns.

## Review Format (when asked to review)

If asked to review animation code, output a single markdown table — never a "Before:/After:" list.

| Before | After | Why |
| --- | --- | --- |
| `transform: scale(0)` | `transform: scale(0.95); opacity: 0` | Nothing appears from nothing |
| `ease-in` on dropdown | strong `ease-out` custom curve | `ease-in` delays the moment the user watches most |
| `hover:scale-105` | `hover:scale-[1.02]`, gated behind `(hover: hover)` | 5% inflates; 1–2% is enough, and touch shouldn't trigger it |
| `transform-origin: center` on popover | `var(--radix-popover-content-transform-origin)` | Popovers scale from their trigger (modals stay centered) |

For a dedicated, exhaustive reviewer with a strict block/approve verdict, use the `review-animations` skill. To name an effect, use `animation-vocabulary`.
