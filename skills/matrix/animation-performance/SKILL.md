---
name: animation-performance
description: Frame budget for web motion — hold 60fps by animating composite-only properties and keeping animation off the main thread. Use when an animation is janky, choppy, or drops frames; when choosing which property to animate (`transform`/`opacity` vs `width`/`height`/`margin`/`top`); when deciding between CSS, WAAPI, and JS/Framer Motion on performance grounds; when a React animation re-renders every frame; or when reaching for `will-change`, GPU layers, or hardware acceleration. Triggers on — janky, choppy, stutter, dropped frames, 60fps, frame budget, 16ms, animation performance, hardware acceleration, GPU, composite, layout recalculation, reflow, style recalc, will-change, requestAnimationFrame, main thread, transform shift, blur performance, CSS variable performance, Framer Motion performance, "works on my machine".
metadata:
  short-description: Hold 60fps in animations (animations.dev course)
---

# Animation Performance

Everything a user feels about your motion collapses into one number: does each frame land inside the **frame budget**? Distilled from Emil Kowalski's *Animations on the Web* course ([animations.dev](https://animations.dev/)), with mechanics from [Motion's performance guide](https://motion.dev/docs/performance).

Imagine [Sonner](https://sonner.emilkowal.ski/) running at 30fps — same easing, same durations, same code. Nobody would have cared. Performance is not a polish pass applied after the motion is good; it's what lets good motion register at all.

## The frame budget

60fps matches most screen refresh rates and is what the brain reads as fluid motion. It gives the renderer **16.7ms** (1000/60) to produce each frame — and on a 120Hz screen, which is now most phones and many laptops, **8ms**. The budget you're designing against is the smaller one.

For scale: a layout recalculation on a complex page can take **upwards of 100ms**. That isn't a missed frame, it's a dozen.

Two axes decide whether you stay inside the budget:

1. **What** you animate — how much work each frame costs → *animate composite-only properties*.
2. **Where** it runs — whether that work can be blocked → *keep the animation off the main thread*.

The first is fully in your control; the second is best-effort, since the browser decides what it accelerates. So spend your attention on axis 1 and treat axis 2 as the reason to keep the door open. Get either wrong and the animation drops frames on someone's device — just not necessarily on yours. **Never conclude "it's fine" from your own machine**; a mid-range phone is the bar.

## Axis 1 — Animate composite-only properties

To reflect a visual change, the browser's renderer runs three steps:

- **Layout** — calculate the size and position of every element on the page.
- **Paint** — draw the page into graphical layers (individual images that compose the page).
- **Composite** — draw those layers to the viewport.

Every property you can animate enters that pipeline at one of three points, and the cost differs by an order of magnitude:

| Tier | Properties | Cost |
| --- | --- | --- |
| **Composite only** | `transform`, `opacity` — plus `filter`, `clip-path`, `background-color` in current Chrome/Firefox | Cheapest. Browsers automatically promote these to their own graphical layer. |
| **Paint + Composite** | `box-shadow`, `border-radius`, `color` | No re-measuring, but an expensive redraw every frame. |
| **Layout + Paint + Composite** | `height`, `width`, `padding`, `margin`, `top`, `left`, `border-width` | Most expensive. A growing element may move everything around it, so the browser recalculates layout every frame. |

`transform` and `opacity` are the safest because they change an element's visual representation, not its position in document flow — nothing needs re-measuring. **Animate them by default.** The less work the browser has to do, the better it performs.

Anything outside `transform`/`opacity` needs testing cross-browser and cross-device, since the compositor support for the newer entries is uneven.

**Swapping down a tier:**

| Instead of | Animate |
| --- | --- |
| `padding` / `width` / `height` to grow or shrink | `scale()` |
| `margin` / `top` / `left` to move | `translate()` (percentages — relative to the element's own size) |
| `visibility` / `display` swaps | `opacity` |
| `box-shadow` | `filter: drop-shadow(10px 10px black)` |
| `border-radius` | `clip-path: inset(0 round 50px)` |

The last two are the ones people miss: an animated shadow or a morphing corner radius looks cheap but repaints the element every frame. `drop-shadow` and `inset()` land the same visual on the compositor.

Two things follow:

- **Whether layout props actually drop frames depends on how much layout is affected.** An element with `position: absolute`, or with very few children, may animate `margin` or `padding` without visible cost. But you don't have to take that bet — a `padding`-driven "scale" animation and a `scale()` one look identical, and only one can't regress on a slower device. Choose the one with no downside.
- **Layout props also move the wrong things.** Animating a sidebar's `margin-left` shifts the text beside it; `translateX` doesn't. For one text node that's harmless. For a dashboard reflowing beside an opening sidebar, it's the whole page re-laid-out every frame.

## Axis 2 — Keep the animation off the main thread

**JavaScript always runs on the main thread.** An animation driven by `requestAnimationFrame` — GSAP, and Framer Motion's React components — competes with everything else the browser is doing. When the main thread is busy, the animation's own code can be blocked from running at all, and the frame is simply late.

Three ways to compute an animation, and only two can escape:

| Driver | Thread |
| --- | --- |
| JS + `requestAnimationFrame` (GSAP, `motion/react`) | Main thread, always |
| Web Animations API (WAAPI, Motion's `animate()`) | Can be hardware-accelerated |
| CSS | Can be hardware-accelerated |

**Hardware acceleration means the animation runs off the main JavaScript thread**, on the GPU, where it stays smooth no matter what the main thread is doing. Note that "JS" and "main thread" aren't synonyms — a JS library that compiles down to WAAPI can be accelerated; a rAF loop cannot.

Reliably accelerated: `transform` and `opacity`. Gaining support: `filter`, `clip-path`, `background-color`, and SVG. **When you know the main thread will be busy, stay inside `transform`, `filter`, `clipPath`, and `opacity`.**

This is not theoretical. Vercel's dashboard animated the active tab highlight with a Framer Motion shared layout animation. Because the browser was busy loading the new page — exactly when the animation plays — it dropped frames. The fix was moving it to a CSS animation, off the CPU.

**The pattern to watch for: motion that runs *while* the page is doing heavy work.** Page transitions, tab switches during navigation, animations that fire alongside data loading or hydration. That's the case where the main-thread cost is guaranteed to bite, and the case where CSS wins.

Framer Motion *can* be hardware-accelerated, but only if you animate the transform as a **string**:

```jsx
<motion.div animate={{ x: 100 }} />                          // main thread, can jank
<motion.div animate={{ transform: "translateX(100px)" }} />  // hardware accelerated
```

**Why:** the individual-transform syntax (`x`, `y`, `scale`, `rotate`) is implemented with CSS variables under the hood, and animated CSS variables are not accelerated. Same root cause as the Vaul trap below — CSS variables are the thing that keeps falling back to the main thread.

The shorthands are more readable, so use them by default — and reach for the string form when the animation must survive a busy main thread.

**Acceleration is progressive enhancement, not a guarantee.** There are many conditions under which a browser silently declines to accelerate, and they change between versions — Chrome, for instance, historically didn't accelerate percentage-based transforms:

```js
animate(element, { transform: "translateX(100%)" })  // may not be accelerated
```

That's worth knowing but not worth reversing course over: percentage translates are the right call for variable-size elements (it's how Sonner and Vaul position toasts and drawers), and correctness beats a best-effort optimization. Treat acceleration as a bonus when the browser grants it. **What you fully control is which properties you animate — that's where the leverage is.**

## React: don't animate through state

Animation libraries like Framer Motion and react-spring animate outside React's render cycle, so they're unaffected. The trap is hand-rolled, state-driven animation.

Updating state every frame — roughly every 16.7ms — re-renders the component every frame, and the render work itself blows the budget. Write to the element instead:

```jsx
// Drops frames: a re-render per frame
setY(nextY);

// Smooth: no re-render
ref.current.style.transform = `translateY(${nextY}px)`;
// or a Framer Motion motion value: y.set(nextY)
```

## Transform shift and `will-change`

One animation can be handed off between the CPU and the GPU, and that hand-off can make the animation visibly shift (typically by a pixel). `will-change` tells the browser to hand the element to the GPU up front, so no hand-off happens mid-animation:

```css
.element {
  /* Lets the browser know this animation should be handled by the GPU. */
  will-change: transform;
}
```

**Add it only once you actually see the shift or dropped frames.** Browsers already promote elements animating `transform`/`opacity` to their own layer automatically, so on the common path `will-change` buys nothing — and every layer takes space on the GPU. Target the elements that animate, not everything.

Where it does earn its place is a genuinely expensive paint: a large blurred or filtered element. Promote it, and **keep the promoted layer small** — a smaller layer is cheaper to composite than a full-screen one.

## Two traps that pass both axes

An animation can be `transform`-only *and* GPU-driven and still be slow:

**Inherited CSS variables.** Vaul's drag gesture became laggy past ~20 list items, with no re-renders involved. The drag position was written to a CSS variable on the drawer, consumed by `translateY()`:

```js
const style = { "--swipe-amount": `${draggedDistance}px` };  // recalcs every child, every frame
```

CSS variables are inheritable, so changing one triggers style recalculation for **every** descendant — the more items, the more expensive each frame. Set the transform directly on the element instead:

```js
const style = { transform: `translateY(${draggedDistance}px)` };
```

Cheap to fix, hours to find. Suspect it whenever a `transform` animation degrades as content grows.

This is the same mechanism that makes Motion's `x`/`y` shorthands unaccelerated. **Animated CSS variables are a main-thread cost with a GPU-looking animation on top** — the tell is a `transform` animation that's slower than it has any right to be.

**Blur.** `filter: blur()` gets laggy very quickly, especially in Safari. Keep animated blur under ~20px (2–5px is plenty to mask a crossfade).

## So should you avoid JS animations?

**No.** The problem only arises when the page is doing heavy processing *during* the animation, which is rare — and you now know how to spot and fix it.

Framer Motion also buys things CSS can't do: real springs, shared layout animations, animating out unmounted components, momentum gestures. It does use `requestAnimationFrame` and it's a sizable package, so the question is whether you need those features — not whether JS animation is allowed.

**The working combination:** CSS for simple motion and anything that must be hardware-accelerated; Framer Motion for complex, dynamic, gesture-driven motion.

## Diagnosing dropped frames

Work down this list — it's ordered by how often each is the cause:

1. **Which properties are animating?** Anything other than `transform`/`opacity` is the first suspect. Layout properties first, then the paint tier — `box-shadow` and `border-radius` are easy to overlook because they don't *look* like layout. `transition: all` hides both in plain sight.
2. **Does the jank coincide with the page being busy?** Navigation, data fetching, hydration, a long task. If so, move the animation to CSS/WAAPI.
3. **Is React re-rendering per frame?** Look for state updates inside `requestAnimationFrame` or a gesture handler.
4. **Does it get worse as content grows?** That's the inherited-CSS-variable recalc, or too many animating nodes.
5. **Is a CSS variable being animated at all?** Including indirectly, via Motion's `x`/`y`/`scale` shorthands.
6. **Any `filter: blur()` above ~20px?** Especially on Safari.
7. **Still shifting or stuttering?** Now add `will-change: transform` to the animating element — and only then.

Confirm with a recording rather than by feel: DevTools Performance panel for dropped frames, and the animation inspector to slow the motion down. Profile on a real mid-range phone over remote debugging, not a desktop with CPU throttling — throttling models a slow CPU, not a weak GPU or a small memory budget.

---

For the surrounding decisions — whether to animate at all, easing, duration, springs, interruptibility — see the `animate` skill. For reduced motion, see `animation-accessibility`.
