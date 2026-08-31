# Animation Standards Reference

The precise values, curves, and rules behind the review. Cite these in findings instead of approximating. Distilled from the *Animations on the Web* course ([animations.dev](https://animations.dev/)).

## Should it animate? (frequency table)

| Frequency | Decision |
| --- | --- |
| 100+ times/day (keyboard shortcuts, command-palette toggle, arrow-key list nav) | No animation. Ever. |
| Tens of times/day (hover effects, list navigation) | Remove or drastically reduce — a 200ms hover used 50×/day feels sluggish |
| Occasional (modals, drawers, toasts) | Standard animation |
| Rare / first-time (onboarding, feedback, celebrations) | Can add delight |

**Never animate keyboard-initiated actions** — they repeat hundreds of times daily; animation makes them feel slow and disconnected. Raycast has no open/close animation — correct for something used hundreds of times a day.

**High-frequency highlights must be instant.** A gently-fading selection highlight looks smoother in a demo but trails one step behind the cursor. Direct connection beats smoothness here.

Valid purposes for motion: purpose/explanation, spatial consistency, state indication, feedback/responsiveness, preventing a jarring change. "It looks cool" on a frequently-seen element is not valid. If everything animates, nothing stands out — pace animation through the experience.

## Easing

Decision order:
- Entering or exiting the screen → **`ease-out`** (starts fast, feels responsive, settles gently)
- Moving / morphing while already on screen → **`ease-in-out`** (car accelerating then decelerating)
- Hover / color / background / opacity → **`ease`** (asymmetric, elegant for small changes; CSS default)
- Constant motion (marquee, timer, spinner, 3D rotation, hold-to-delete) → **`linear`**
- Default → **`ease-out`**

**Never `ease-in` on UI.** It starts slow, delaying the exact moment the user is watching, then accelerates into the stop — the opposite of how things settle in the real world.

**Built-in CSS easings are almost never strong enough** — their acceleration is too weak, so animations feel flat/slow. Every course example uses a custom curve. Prefer **asymmetric** curves (steep start, slow settle) — they feel alive and mimic a spring without a spring. AI defaults to named curves (`ease-out`, `ease-in-out`) because they dominate training data — treat those as *categories*, then pick a real cubic-bezier.

Course curves worth citing:

```css
--ease-out-expo:      cubic-bezier(0.19, 1, 0.22, 1);        /* strong ease-out: card hover, text reveal */
--ease-out-quad:      cubic-bezier(0.25, 0.46, 0.45, 0.94);  /* button press feedback */
--ease-in-out-cubic:  cubic-bezier(0.645, 0.045, 0.355, 1);  /* on-screen back-and-forth */
--ease-in-out-circ:   cubic-bezier(0.785, 0.135, 0.15, 0.86);/* download arrow */
--ease-vaul:          cubic-bezier(0.32, 0.72, 0, 1);        /* iOS sheet — extremely steep start (Ionic) */
--ease-drawer-height: cubic-bezier(0.25, 1, 0.5, 1);         /* Family Drawer height — strong, snappy */
```

The blueprint ships 16 curves sorted weakest→strongest per easing type. When an animation feels flat, the curve is probably too weak. Find/tune curves at easing tools rather than hand-rolling.

## Duration

| Element | Duration |
| --- | --- |
| Button press feedback | ~150ms |
| Tooltips, small popovers | 125–200ms |
| Dropdowns, selects | 150–250ms (180ms feels more responsive than 400ms) |
| Modals, drawers | 200–500ms |
| Small floating drawer (Family) | ~270ms (`0.27s`) |
| Full iOS-style sheet (Vaul default) | ~500ms |
| Wide nav-menu viewport resize | ~250ms |
| Big element crossing the screen (Vercel time machine) | ~1s |
| Marketing / explanatory | Can be longer |

**Rule: UI animations stay under ~300ms** unless justified. A 180ms dropdown feels more responsive than 400ms. Faster spinners make load *feel* faster (same real time).

**Duration and easing are inseparable.** A slow/weak curve needs a shorter duration; a steep curve (Vaul's) can afford a longer one — Vaul's 500ms doesn't feel slow because the curve front-loads the movement. **Duration scales with element size and travel distance** — a full-screen mobile menu justifies >300ms; a truck stops slower than a bicycle. **Exits are shorter and simpler than entries** — the user already decided; get out of the way. Too fast is as bad as too slow (trackability threshold). Marketing pages can run longer; product must feel fast.

**Process:** choose the easing first, then tune the duration to it.

**Adaptive duration** — make a crossfade's duration proportional to how much the element changed, so small changes don't over-fade:

```js
const MIN_DURATION = 0.15, MAX_DURATION = 0.27;
const delta = Math.abs(bounds.height - previousHeightRef.current);
const duration = Math.min(Math.max(delta / 500, MIN_DURATION), MAX_DURATION);
```

## Physicality

- **Never `scale(0)`.** Start entrances from `scale(0.9–0.95)` + `opacity: 0`. Nothing in the real world appears from nothing; a near-full start reads as "it was always almost there." Floating elements (menus): the bigger the element, the higher the initial scale (a nav menu uses `scale(0.98)`).
- **Button press feedback:** `transform: scale(0.97)` on `:active`, `transition: transform ~150ms`. Subtle — press feedback is *felt, not seen*; `scale(0.9)` visibly collapses. Buttons feel best with **both** hover and press feedback; a hover with nothing on click feels dead.
- **Hover scale:** 1–2% is enough to signal interactivity. `hover:scale-105` almost always inflates like a balloon. Hover duration 100–150ms (300ms feels swimmy).
- **Origin-aware popovers.** Scale from the trigger, not center (default `transform-origin: center` is wrong for almost every triggered element):
  ```css
  .popover { transform-origin: var(--radix-popover-content-transform-origin); } /* Radix */
  .popover { transform-origin: var(--transform-origin); }                       /* Base UI */
  .menu    { transform-origin: top center; }                                    /* trigger above */
  ```
  **Modals are exempt** — they appear centered, keep `transform-origin: center`.
- **Hover lift must move a child, not the hover target.** Animating `translateY` on the hovered element moves it out from under the cursor → hover ends → drops → flicker loop. Put the lift on an inner element:
  ```css
  .box:hover .box-inner { transform: translateY(-20%); }
  .box-inner { transition: transform 200ms ease; }
  ```

## Springs

Feel natural because they simulate physics; no fixed duration — they settle on parameters. Use for: drag with momentum, "alive" elements (Dynamic Island), interruptible gestures, decorative mouse-tracking. Real springs are impossible in pure CSS (only approximable with `linear()`).

```js
// Apple / Motion style (easier to reason about) — recommended for UI text/state swaps
{ type: "spring", duration: 0.3, bounce: 0 }
{ type: "spring", duration: 0.5, bounce: 0.2 }

// Traditional physics (more control) — mass / stiffness / damping
{ type: "spring", stiffness: 100, damping: 10, mass: 0.75 }
```

- **Default bounce to 0.** No overshoot keeps UI transitions natural and elegant. Add bounce only intentionally — a slight bounce at the end of a *drag* (a drag applies force); a press-to-close gets none. Bounce communicates personality: more = playful, zero = serious.
- **Bounce scales inversely with element size** — smaller views need *more* bounce to read the same. Dynamic Island hardcodes it per transition, e.g. `idle: 0.5`, `timer-ring: 0.35`, `timer-idle: 0.3`.
- **Interruptible / momentum:** a spring re-targeted mid-motion carries its velocity, so redirected motion stays smooth (keyframes restart from zero — that's the Sonner "toast jump" bug).
- **`useSpring` vs `useMotionValue`:** use `useSpring` for most interactions (a direct `useMotionValue` feels lifeless); use `useMotionValue` when the value must track a gesture 1:1 (drag-to-dismiss scale). "Weird" spring movement is usually fixed by increasing `damping`.
- You don't need springs for simple color/opacity transitions. Libraries add bundle size — a real trade-off (Vaul chose a small package over native spring feel).

## Interruptibility

CSS **transitions** can be interrupted and retargeted mid-flight; `@keyframes` restart from zero. For anything triggered rapidly (toasts, toggles, drawers, accordions), use transitions or springs — keyframes make new items "jump" to their target.

```css
/* Interruptible — good for dynamic UI */
.toast { transition: transform 400ms ease; }
```

Use `@starting-style` for enter without JS (now widely supported):

```css
.toast {
  opacity: 1; transform: translateY(0);
  transition: opacity 400ms ease, transform 400ms ease;
  @starting-style { opacity: 0; transform: translateY(100%); }
}
```

Legacy fallback: `useEffect(() => setMounted(true), [])` + a `data-mounted` attribute driving the target state. Radix/Base UI animate exit via `[data-state="open"|"closed"]` (they suspend unmount so the exit keyframe plays).

## Asymmetric timing

Slow where the user is deciding, fast where the system responds. Declare different transitions on the base vs `:active` state:

```css
.hold-overlay        { transition: clip-path 0.2s ease-out; }  /* release: fast snap-back */
.button:active .hold-overlay { transition: clip-path 1.5s linear; } /* hold: slow, even reveal */
```

## Performance

- **Only animate `transform` and `opacity`** — they touch just the Composite step. `width`/`height`/`margin`/`padding`/`top`/`left` trigger Layout + Paint + Composite (expensive, drop frames). Exception: `position:absolute` or very few children can get away with layout props. Target 60fps (≤16.7ms/frame).
- **Prefer `transform: translate` (percentages) over `margin`/`top`; `scale` over animating `width`/`height`/`padding`.** `translateY(100%)` moves by the element's own height regardless of size (how Sonner/Vaul position toasts/drawers).
- **Framer Motion `x`/`y`/`scale` shorthands are NOT hardware-accelerated** — they run on the main thread via rAF and drop frames under load. Animate the full string when it must be smooth:
  ```jsx
  <motion.div animate={{ x: 100 }} />                          // main-thread, can jank
  <motion.div animate={{ transform: "translateX(100px)" }} />  // hardware accelerated
  ```
- **Don't drive child transforms via a CSS variable on the parent** — inherited vars recalc styles for *all* descendants (the Vaul `--swipe-amount` lag past ~20 items). Set `transform` directly on the element.
- **CSS animations beat JS under load** — they run off the main thread; rAF-based (Framer Motion) animations stutter while the browser is busy. Use CSS/WAAPI for predetermined motion, JS for dynamic/interruptible. (Vercel fixed a dropped-frame tab highlight by moving it from FM shared-layout to CSS.)
- **`will-change: transform`** fixes the 1px CPU↔GPU "transform shift," and promotes heavy elements to a GPU layer — but **add it only when you actually see dropped frames**. Too many GPU layers cost memory. Target `[data-animate]`, not everything. For expensive filtered/blur SVG elements: `transform: translateZ(0)` + `contain: layout style paint` (isolates repaint from siblings).
- **Don't animate through React state** at 60fps — it re-renders every frame. Update a motion value / the `style` property directly instead.
- **Blur filters ≤ ~20px** — blur gets laggy fast, especially in Safari; keep animated blur small (2–5px is plenty).

## Transforms & clip-path

- **`translate` percentages** are relative to the element's own size — robust for variable-size elements. Prefer over hardcoded px.
- **`scale()` scales children too** (font, icons, border-radius) — a feature for press feedback and zoom.
- **Order matters** — `rotate` then `translateX` ≠ `translateX` then `rotate`.
- **3D:** `rotateX/Y` + `transform-style: preserve-3d` on the parent (+ `perspective`, `translateZ`, `backface-visibility: hidden`) for depth/orbit/flip without JS.
- **`clip-path: inset(t r b l)`** eats in from each side; no layout effect (no shift) and hardware-accelerated. Uses: image reveal on scroll (`inset(100%)` → `inset(0)`, more performant than height), hold-to-delete overlay (reveal left→right, `linear`), seamless tab color transitions (duplicate the active copy and clip it), comparison sliders, text masks. Trigger scroll reveals with Intersection Observer (or FM `useInView`) — avoid pulling in a heavy library just for this.

## Framer Motion / Motion (motion/react)

- Import from `motion/react` (formerly `framer-motion` — same API).
- **`AnimatePresence` requires a `key`** on the animating child or the exit animation won't fire. `mode="wait"` = old fully out before new in; `mode="popLayout"` = exit and enter simultaneously with siblings reflowing (crossfade-like, chip/list removal). `initial={false}` skips the mount animation for state swaps.
- **Pass `custom` to both `AnimatePresence` and the `motion` element** — an exiting element's state is otherwise stale (direction-aware slides break without it).
- **`layout` / `layoutId`:** `layout` animates any layout change (even `flex-direction`); `layoutId` morphs one element into another (shared-element transitions, tab indicators, App-Store cards). Add `layout` to siblings that would otherwise jump.
- **Layout animations distort `border-radius`/`box-shadow`** (they use `transform`) — FM corrects radius **only if it's in pixels**. Use inline `style={{ borderRadius: 12 }}`, never a `rem`/className radius, when animating layout.
- **Animate height to a measured value, not `auto`** (FM can't do `auto`→`auto`). Measure with `useMeasure`/`ResizeObserver`; put the `ref` on an **inner** element (with the padding), not the same element carrying `animate={{ height }}`. Guard first render: `height: bounds.height ? bounds.height : null`.
- **Motion values** (`useMotionValue`, `useSpring`, `useTransform`, `useMotionTemplate`) update outside React's render cycle → 60fps without re-renders. `useMotionTemplate` is required to embed a motion value in a string reactively (e.g. `inset(0 ${x}% 0 0)`).
- Prefer declarative props; reach for imperative `useAnimate([scope, animate])` only to orchestrate many elements across events (target `[data-animate]` selectors, use a `times` array for staggered keyframes, return `Promise.all` to await).
- `MotionConfig transition={...}` sets a default transition for all descendants; `MotionConfig reducedMotion="user"` makes FM animate only opacity/background app-wide.

## SVG animation

- `viewBox="0 0 w h"` is the camera (enables responsive scaling; keep animation values consistent). Close paths with `Z` (an open path shows an awkward corner). Degenerate shapes (`width=0`, `r=0`, coincident endpoints) don't render at all.
- **Line drawing:** `stroke-dasharray` = full path length as one dash + a large gap, `stroke-dashoffset` = path length (hidden), animate offset → 0 to draw. Use `pathLength="100"` to work in percentages / share values. `animation-fill-mode: forwards` is required or it snaps back. Stagger multiple strokes with `animation-delay`. **`stroke-linecap: round` peeks past the dash** — make the gap slightly larger than the dash.
- **`transform-origin` in SVG defaults to the viewBox `(0,0)`, and `center` means the viewBox center**, not the element. Use `transform-box: fill-box` to make origin relative to the element's own box (percentages/`center` behave like HTML), or `transform-box: view-box` with pixel coords to rotate around a distant point. **Motion overrides `transformOrigin` set in `style` with `50% 50%`** — set it in the `initial` prop instead.
- Nest `<g>` groups to layer independent transforms; `overflow: visible` on the SVG so overshoot/scale doesn't clip. Path morphing: `useTransform(progress, [0,1], [pathA, pathB])` — only when both paths share point structure (else use flubber).

## Stagger & orchestration

Stagger group entrances 30–80ms between items — longer feels slow. **Vary the delay/distance by visual importance** (most important appears first with the most screen time; least important can just fade in without sliding). Uniform stagger (identical delay/distance/easing) kills hierarchy and feels artificial. Stagger is decorative — never block interaction while it plays.

**One entrance per container.** Don't slide a panel in *and* trickle its children in — slide the panel in with content already there. Sometimes the best animation is no animation.

```css
.item { opacity: 0; transform: translateY(8px); animation: fadeIn 300ms ease-out backwards; }
.item:nth-child(2) { animation-delay: 50ms; }
.item:nth-child(3) { animation-delay: 100ms; }
@keyframes fadeIn { to { opacity: 1; transform: translateY(0); } }
```

Ambient "subtle life": barely-perceptible float + rotation on idle scenes, with **deliberately non-syncing durations** (e.g. 3s and 4s) so layers never line up and it reads organic, not mechanical. Give idle loops an initial delay so users discover interactions first.

## Masking imperfect crossfades

When a crossfade shows two overlapping states despite tuning easing/duration, add a subtle `filter: blur(2px)` during the transition to blend them into one perceived transformation. Keep blur small (< ~20px; heavy blur is expensive, especially Safari).

## Numbers & text

- Use **`tabular-nums`** for changing digits (timers, counters) so widths stay fixed and don't shift.
- Text-swap pattern: keyed `motion.span` in `AnimatePresence mode="popLayout" initial={false}`, `initial {opacity:0, y:-25}` → `animate {opacity:1, y:0}` → `exit {opacity:0, y:25}`, `transition {type:"spring", duration:0.3, bounce:0}`.

## Accessibility

**Reduced motion means gentler, not zero** — keep transitions that aid comprehension (opacity/color), remove movement/position changes. For purely decorative animation, disable it fully (keeping a float would falsely imply interactivity).

```css
@media (prefers-reduced-motion: reduce) {
  .element { animation: fade 0.2s ease; } /* replace movement, don't just delete */
}
@media (hover: hover) and (pointer: fine) {
  .element:hover { transform: scale(1.02); } /* gate hover — touch fires false hovers on tap */
}
@media (prefers-reduced-motion: no-preference) {
  html { scroll-behavior: smooth; }
}
```

```jsx
const reduce = useReducedMotion();               // motion/react
const closedX = reduce ? 0 : "-100%";
// app-wide: <MotionConfig reducedMotion="user"> animates only opacity/background
```

Disable autoplaying animations under `reduce`; for looping animations, pause on a representative "hero" frame (`animation-play-state: paused; animation-delay: -0.4s`) rather than frame 0. For essential visual sequences, jump between frames instead of tweening. **Tap targets ≥ 44×44px** (enlarge with a `::before` hitbox without changing layout). On touch devices, hover+click fire together — detect `pointer: coarse` and use a two-tap pattern (first tap = hover, second = click).

## Debugging (recommend when feel is uncertain)

- **Record & slow down** (2–5× or DevTools animation inspector): check colors crossfade cleanly, easing doesn't stop abruptly, `transform-origin` is right, coordinated properties stay in sync. Tune magic transform values live in the console.
- **Frame-by-frame** reveals timing drift between coordinated properties.
- **Real devices** for gestures (drawers, swipe) — hit the dev server by IP, use Safari remote devtools; opacity-heavy transitions want high refresh-rate screens.
- **Fresh eyes the next day** — don't code and ship in one sitting; Sonner's transitions were replayed and tweaked daily for days before release.

## Cohesion

All of a component's sub-animations should share a timing feel so it reads as **one entity** (Family Drawer overrides Vaul's 500ms to 200ms so opening and height changes feel unified). Match motion to personality: playful can be bouncier; a professional dashboard stays crisp and fast (Sonner uses `ease` rather than `ease-out`, slightly slower, to feel elegant). Exit direction matches entry direction; navigation maps forward=left / back=right; a zoomed view expands from its thumbnail (object permanence), it doesn't fade in from nowhere. Prefer a crossfade with a subtle directional hint (8px shift + opacity + light blur) over a heavy full slide for small, structurally-similar content.
