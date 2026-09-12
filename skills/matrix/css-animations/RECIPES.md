# CSS Animation Recipes

Worked patterns from the CSS Animations module. Each one exists because of a detail that isn't obvious until it bites you — the detail is the point, not the effect.

Load from [SKILL.md](SKILL.md).

## Hover lift without the flicker

Moving an element on hover can move it out from under the cursor, which drops the hover state, which moves it back — a flicker loop.

**Move a child, keep the hover target still.**

```css
.box:hover .box-inner { transform: translateY(-20%); }

.box-inner {
  transition: transform 200ms ease;
}
```

The parent's bounds never change, so the cursor stays inside it the whole time.

## Card hover reveal

A description hidden below the card, revealed on hover.

```css
.card {
  overflow: hidden;           /* without it the description shows outside the card */
}

.card-description {
  --margin: 6px;
  margin: var(--margin);
  /* own height + margin, +1px because an outside shadow acts as a border here */
  transform: translateY(calc(100% + var(--margin) + 1px));
  transition: transform 500ms cubic-bezier(0.19, 1, 0.22, 1); /* ease-out-expo */
}

.card:hover .card-description,
.card:focus-visible .card-description {
  transform: translateY(0);
}
```

Three details: hide by the element's own size **plus** its margin (a CSS variable keeps the two in sync); `500ms` reads fine because the curve is so steep at the start; and `:focus-visible` matters because the revealed content is real information a keyboard user would otherwise never see.

## Download arrow (two elements, one motion)

The arrow slides out the bottom while a second arrow arrives from the top.

```css
.download-button {
  display: grid;
  place-items: center;
  overflow: hidden;
}

svg {
  grid-area: 1 / 1;                     /* both arrows in the same grid cell */
  transition: transform 200ms cubic-bezier(0.785, 0.135, 0.15, 0.86);
}

svg:first-of-type { transform: translateY(-150%); }  /* parked above */

.download-button:hover svg:first-of-type { transform: translateY(0); }
.download-button:hover svg:last-of-type  { transform: translateY(150%); }
```

`grid-area: 1 / 1` is the cleanest way to stack elements. `150%` rather than `100%` because the arrow is smaller than the button — its own height isn't enough to clear the edge.

## Toast stack (interruptible enter, CSS only)

Sonner's expanded mode. New toasts push the stack up; if one arrives while the previous is still moving, the target changes mid-flight — which is exactly why this is a **transition**, not a keyframe animation.

```tsx
{Array.from({ length: toasts }).map((_, i) => (
  <Toast key={i} index={toasts - (i + 1)} />   /* invert: newest gets index 0 */
))}

<div className="toast" style={{ "--index": index }} data-mounted={mounted} />
```

```css
.toast {
  position: absolute;
  bottom: 0;
  opacity: 0;
  transform: translateY(100%);
  transition: opacity 400ms ease, transform 400ms ease;
}

.toast[data-mounted="true"] {
  transform: translateY(calc(var(--index) * (100% + var(--gap)) * -1));
  opacity: 1;
}
```

Stack with `position: absolute; bottom: 0`, then place each toast at `index × (own height + gap)`, negated to move up. Invert the index in JS so the newest toast sits at the bottom.

`400ms` with `ease`: anything faster felt wrong for an element this small, and `ease` keeps it soft and elegant.

The mount flip (`useState(false)` + `useEffect(() => setMounted(true), [])`) is only needed for the enter transition. Modern equivalent, no state:

```css
.toast {
  opacity: 1;
  transform: translateY(...);
  @starting-style {
    opacity: 0;
    transform: translateY(100%);
  }
}
```

This is what a Motion layout animation would have cost you — and it's a handful of CSS.

## Stacked cards (Sonner's collapsed stack)

Cards fanned behind each other: each one further back is scaled down and pushed up.

```tsx
{new Array(LENGTH).fill(0).map((_, i) => (
  <div className="card" key={i} style={{ "--index": LENGTH - 1 - i }} />
))}
```

```css
.card {
  --scale-increment: 0.05;
  --translate-increment: -13%;
  transform:
    scale(calc(1 - var(--index) * var(--scale-increment)))
    translateY(calc(var(--index) * var(--translate-increment)));
}
```

The `nth-child` version works but hardcodes every card. The variable version takes any number of cards without touching CSS — which is why it's the one in Sonner. Also useful for card stacks and nested dialogs.

## Text reveal (stagger)

Each letter rises into place a beat after the last.

```tsx
<h1>
  {WORD.split("").map((char, index) => (
    <span key={index} style={{ "--index": index }}>{char}</span>
  ))}
</h1>
```

```css
.h1 { overflow: hidden; }              /* hides the letters' parked position */

.h1 span {
  display: inline-block;               /* inline elements have no box to transform */
  animation: reveal 1.3s cubic-bezier(0.19, 1, 0.22, 1) backwards;
  animation-delay: calc(0.03s * var(--index));
}

@keyframes reveal {
  from { transform: translateY(100%); }
  to   { transform: translateY(0); }
}
```

Four things that each break it on their own: `inline-block` (transforms need a box), `overflow: hidden` (or the letters are visible below the line), `backwards` (or every letter shows in its natural position until its delay elapses), and `0.03s` per letter — small, because the delays accumulate across the whole word.

## Orbit (3D)

A small circle orbiting a larger one, staying face-on to the viewer.

```css
.wrapper {
  transform-style: preserve-3d;   /* without it, the circle can't pass behind */
  perspective: 500px;             /* bonus: near/far changes its apparent size */
}

.orbitingCircle {
  animation: orbit 6s linear;
  animation-iteration-count: infinite;
}

@keyframes orbit {
  from { transform: translate(-50%, -50%) rotateY(0deg)   translateZ(74px) rotateY(360deg); }
  to   { transform: translate(-50%, -50%) rotateY(360deg) translateZ(74px) rotateY(0deg); }
}
```

`rotateY` is the revolution; `translateZ` is the orbit's radius (the origin stays put, so pushing the element out along z and rotating sweeps a circle). The **trailing counter-`rotateY`** cancels the element's own spin so it always faces front. `linear`, because orbits don't accelerate. Slow it down if it's ambient background motion — distraction is the failure mode.

## Coin flip (3D, two faces)

```css
.wrapper {
  transform-style: preserve-3d;
  animation: rotate 2s infinite linear;
}

.coin {
  position: absolute;
  backface-visibility: hidden;    /* each face is invisible from behind */
  border-radius: 50%;
}

.front { transform: translateZ(3px); }
.back  { transform: rotateY(180deg) translateZ(3px); }

.coin-side {                      /* the rim, standing on edge */
  transform: translateX(26px) rotateY(90deg);
  width: 6px;
}

@keyframes rotate { to { transform: rotateY(360deg); } }
```

Build two faces plus a rim, then rotate the parent. What looks like a 3D object is `rotateY` and `backface-visibility`.

## Blinking cursor / marquee

```css
@keyframes blink { 50% { visibility: hidden; } }   /* 0% and 100% inferred */
```

A marquee is the same shape: `@keyframes` with `animation-iteration-count: infinite` and `linear` — one of the few genuinely correct uses of `linear`.

## clip-path: comparison slider

Overlay two images and clip the top one from the right, driven by the drag position:

```css
.top-image { clip-path: inset(0 50% 0 0); }
```

More performant than the two-divs-with-`overflow: hidden` approach, and it needs no extra DOM. The same trick with two versions of the same text (outlined and solid, split horizontally) gives a text mask that doesn't read as a slider at all.

## clip-path: image reveal on scroll

Animate `inset(100%)` → `inset(0)`. Better than a height animation: hardware-accelerated, and no layout shift because the image is already laid out, just clipped.

It has to fire when the image enters the viewport or nobody sees it. Use the [Intersection Observer API](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API) unless the project already ships Motion — in that case `useInView` with `once: true` and `margin: "100px"` (fire when 100px of the image is in view).

## clip-path: seamless tab highlight

The usual approach transitions the text color and hopes the timing lines up with the moving pill. It never quite does.

Instead: **duplicate the whole tab list**, style the copy as if every tab were active (filled background, white text), then clip that copy to just the active tab. Moving the highlight is one animated `clip-path` — the colors are always already correct, so there's no color transition to time.

Nobody consciously notices the difference, and that's fine; details like this add up. (Technique originally from [Paco](https://x.com/pacocoursey/status/1522639642155266048); Stripe's blog ships it.)

## clip-path: theme switch wipe

Render both themes stacked and animate the `clip-path` of one to wipe the other in. Same code as the image reveal. Duplicating the page is hacky — the modern route is the [View Transitions API](https://theme-toggle.rdsx.dev/) — but it works and it's a fast prototype.

## Hold to delete

A red overlay wipes across the button while held, and snaps back on release.

```css
.hold-overlay {
  position: absolute;
  inset: 0;
  background-color: #ffdbdc;
  color: #e5484d;
  clip-path: inset(0px 100% 0px 0px);      /* hidden from the right */
  transition: clip-path 0.2s ease-out;     /* release: fast and snappy */
}

.button:active .hold-overlay {
  clip-path: inset(0px 0px 0px 0px);
  transition: clip-path 1.5s linear;       /* hold: slow and perfectly even */
}

.button {
  transition: transform 0.16s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.button:active { transform: scale(0.97); }
```

**Two different transitions, and that's the whole recipe.** A deliberate action (holding) reveals slowly and `linear`, because the fill is a progress indicator and must advance evenly. Releasing is a system response: `0.2s ease-out`. One shared transition would make the cancel feel broken.

Duplicate the button's content inside the overlay so the wipe reveals a red copy of the same label and icon.
