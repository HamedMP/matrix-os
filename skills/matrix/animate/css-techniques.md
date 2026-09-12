# CSS Animation Techniques

Implementation recipes for CSS motion. Load from [SKILL.md](SKILL.md) when writing CSS. All values from the *Animations on the Web* course.

## Transitions vs keyframes — which to reach for

**Use a CSS transition when** the change is triggered by user interaction (hover, click, state change) and might be interrupted or retargeted mid-flight (Sonner toasts shifting position). Transitions interpolate from the *current* value, so they're smooth when reversed.

**Use `@keyframes` when** the animation runs automatically (page-load intro), loops infinitely (marquee, spinner), has multiple steps (pulse, shake), or is a one-shot enter/exit that never needs interruption. Keyframes restart from zero, so they're the wrong tool for anything toggled rapidly.

## Transitions

`transition` is shorthand for `property duration timing-function delay`:

```css
.button { transition: transform 0.2s ease; }
.button { transition: transform 0.2s ease 0.1s; } /* trailing value = delay */
```

Rules:
- **Put the transition on the base state, not only `:hover`** — otherwise the return to default is instant.
- **Avoid `transition: all`** — be explicit so you never animate an unintended property. For several properties sharing timing, use `transition-property`:
  ```css
  .button {
    transition: 0.2s ease;
    transition-property: color, background-color, border-color;
  }
  ```
- Write `ease` out explicitly — people wrongly assume the default is `linear` (it's `ease`).
- Declare `transition-delay` separately for readability rather than as the 4th shorthand value.

### Enter animation with `@starting-style` (no JS)

The modern way to animate an element in on first render:

```css
.toast {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 400ms ease, transform 400ms ease;
  @starting-style {
    opacity: 0;
    transform: translateY(100%);
  }
}
```

Legacy fallback: mount with an initial state, then flip a `data-mounted` attribute in `useEffect(() => setMounted(true), [])` and transition to the target.

Radix / Base UI animate **exit** via `[data-state="open"|"closed"]` (they suspend unmount so the closing keyframe plays):

```css
@keyframes scaleIn  { from { opacity: 0; scale: 0.98; } to { opacity: 1; scale: 1; } }
@keyframes scaleOut { to { opacity: 0; scale: 0.98; } }              /* omit `from` — inherits current */
.content[data-state="open"]  { animation: scaleIn  200ms ease; }
.content[data-state="closed"]{ animation: scaleOut 200ms ease; }
```

## Keyframes

```css
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.el { animation: fade-in 1s ease; }
```

- `animation-fill-mode: forwards` keeps the end state (most common — dialogs/popovers). `backwards` applies the first keyframe before the animation starts (useful for delayed enters so you don't set initial styles by hand). `both` does both.
- Omitting `0%`/`100%` makes CSS use the element's existing values there (`@keyframes blink { 50% { visibility: hidden; } }`).
- `animation-iteration-count: infinite` for loops; `animation-direction: alternate` for back-and-forth; `animation-play-state: paused` to pause (transitions can't).
- Re-trigger a keyframe animation in React by changing the element's `key`.

## Transforms

Transform moves/rotates/scales without affecting document flow (siblings lay out as if it hadn't moved).

- **`translate` percentages are relative to the element's own size** — `translateY(100%)` moves it down by its own height regardless of dimensions (how Sonner/Vaul position toasts/drawers). Prefer percentages over hardcoded px. Prefer `translateX`/`translateY` over `translate(x,y)`.
- **`scale` scales children too** (font, icons, `border-radius`) — a feature for press feedback and zoom. Almost never animate from `scale(0)`; combine ~`0.9` with opacity instead.
- **Rotation looks best with `ease-in-out`** (natural accel/decel). Pure constant rotation (loaders, coins) uses `linear`.
- **Order matters** — `rotate` then `translateX` ≠ `translateX` then `rotate`.
- **`transform-origin`** defaults to center; set it to the trigger for origin-aware popovers.

### 3D

```css
.parent { perspective: 500px; transform-style: preserve-3d; }
.child  { transform: rotateY(20deg) translateZ(74px); backface-visibility: hidden; }
```

- `preserve-3d` on the parent lets children live in real 3D space (needed for orbits, depth, a child going behind another).
- `translateZ` needs `perspective` on the parent to be visible; closer to z0 = more pronounced.
- Orbit = `rotateY` for the revolution + `translateZ` for the radius, with a counter-`rotateY` to keep the element facing front.

### Stacked cards / toasts (Sonner)

Mix `translateY` (negative = up) and `scale`, driven by an inverted `--index` so you can add cards without touching CSS:

```css
.card {
  --scale-increment: 0.05;
  --translate-increment: -13%;
  transform:
    scale(calc(1 - var(--index) * var(--scale-increment)))
    translateY(calc(var(--index) * var(--translate-increment)));
}
```

Pass `style={{ "--index": LENGTH - 1 - i }}` so the front card is index 0.

## Hover patterns

**Fix hover flicker** (lift moving the element out from under the cursor) by moving a child, not the hover target:

```css
.box:hover .box-inner { transform: translateY(-20%); }
.box-inner { transition: transform 200ms ease; }
```

**Make hover-revealed info keyboard-accessible and touch-safe:**

```css
.card:hover .desc, .card:focus-visible .desc { transform: translateY(0); }
@media (hover: hover) and (pointer: fine) { .card:hover { background: blue; } }
```

Use `:focus-visible` (keyboard) not `:focus` (also fires on click). In Tailwind v4 `hover:` is already gated to devices that support hover.

**Reveal by pushing out of an `overflow: hidden` container**, accounting for margin so it fully hides:

```css
.container { overflow: hidden; }
.item { --margin: 6px; transform: translateY(calc(100% + var(--margin) + 1px)); } /* +1px if an outside shadow acts as a border */
```

## clip-path

`clip-path` clips an element to a shape with **no layout effect** (no shift) and is **hardware-accelerated** — often better than animating `width`/`height`. `inset(top right bottom left)` eats in from each side; `inset(100%)` hides the whole element, `inset(0)` shows it.

Common patterns:

- **Image reveal on scroll** — animate `inset(100%)` → `inset(0)`; more performant than height and avoids layout shift. Trigger with Intersection Observer (or FM `useInView` with `once`/`margin`) so the user actually sees it.
- **Comparison slider** — overlay two images; the top one gets `clip-path: inset(0 50% 0 0)`, adjusted by drag.
- **Seamless tab highlight** — duplicate the tab list styled active, clip it to the active tab, animate the clip on click (avoids color-transition timing problems).
- **Hold-to-delete** — a red `position:absolute; inset:0` overlay hidden from the right (`inset(0 100% 0 0)`), revealed left→right while held. Reveal slowly and evenly, snap back fast — **asymmetric transitions**:
  ```css
  .hold-overlay { transition: clip-path 0.2s ease-out; }          /* release: fast */
  .button:active .hold-overlay { transition: clip-path 1.5s linear; } /* hold: slow, even */
  .button:active { transform: scale(0.97); }
  ```

## Stagger (CSS)

Split into per-item elements, pass an `--index`, and delay by it. Letters/inline elements need `display: inline-block` (transforms need a box) and `overflow: hidden` on the container to hide their initial position; use `animation-fill-mode: backwards` so they aren't visible before starting.

```css
.item { animation: enter 0.6s ease both; animation-delay: calc(var(--delay) * var(--stagger)); --delay: 120ms; }
@keyframes enter { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
```

For a self-drawing check/reveal, stagger with `animation-delay`; see [svg-animation.md](svg-animation.md).
