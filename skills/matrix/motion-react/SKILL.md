---
name: motion-react
description: Build animations with Motion for React (`motion/react`, formerly Framer Motion) the way the "Animations on the Web" course (animations.dev) teaches — and debug them when the magic misfires. Use when writing motion components, exit animations, layout or shared-element morphs, springs, motion values, or drag gestures; when deciding whether a job needs the library at all; or when an exit animation won't play, a morph distorts its border radius, a direction-aware slide points the wrong way, or an auto height jumps. Triggers on — motion/react, framer-motion, motion.div, initial animate exit, AnimatePresence, popLayout, mode wait, layout animation, layoutId, shared element transition, variants, custom prop, MotionConfig, useMotionValue, useSpring, useTransform, useMotionTemplate, useInView, useReducedMotion, useAnimate, useMeasure, animate height auto, drag, dragConstraints, dragMomentum, whileTap, spring bounce, stiffness, damping.
metadata:
  short-description: Build and debug Motion for React animations (animations.dev)
---

# Motion for React

The Framer Motion module of Emil Kowalski's *Animations on the Web* course ([animations.dev](https://animations.dev/)), as a working reference.

Framer Motion is now **Motion for React**. Nothing changed but the import path:

```jsx
import { motion, AnimatePresence } from "motion/react";  // was "framer-motion"
```

For the component builds — feedback popover, multi-step flow, trash interaction, interactive graph, App Store card — load **[RECIPES.md](RECIPES.md)**.

## Reach for it only when CSS can't

Everything Motion does is possible in vanilla CSS and JS. It just takes far longer. Emil's own default is to skip the library when CSS gets there in reasonable time — enter/exit for modals and dropdowns via Radix's `[data-state]` attributes covers most of it, since Radix suspends unmount while a closing animation plays.

Reach for Motion when CSS genuinely can't:

- **Real spring physics** — interruptible motion that keeps momentum.
- **Layout changes**, including properties CSS can't animate at all (`flex-direction`, `justify-content`).
- **Shared-element morphs** — one element becoming another (`layoutId`).
- **Animating out unmounted components** (`AnimatePresence`) — hard in React, because the component is already gone.

The deciding factor is usually bundle size and what the project already ships. Vercel kept Motion out of the Next.js docs and rewrote a copy-button animation in CSS to save the weight; in Clerk's dashboard, which already had it, Emil reaches for it freely to save time and keep the code readable.

The cost of all this: **magic**. Complex animations come out of very little code, so when something misbehaves you're debugging a black box, and the docs mostly follow the happy path. The Debugging section below is the map for that.

## Basics

```jsx
<motion.div
  initial={{ opacity: 0, scale: 0.95 }}
  animate={{ opacity: 1, scale: 1 }}
/>
```

`initial` is the start state, `animate` the end state. Values are interpolated in JavaScript, **outside React's render cycle** — an animating component doesn't re-render, which is what makes 60fps achievable.

## Transitions and springs

Without a `transition`, Motion picks per value type: physical values (`x`, `scale`) get a **spring**, everything else (`opacity`, `color`) gets a **tween**.

```jsx
transition={{ duration: 0.3, ease: "easeOut" }}                          // tween
transition={{ type: "spring", duration: 0.3, bounce: 0 }}                // state swaps, no overshoot
transition={{ type: "spring", duration: 0.5, bounce: 0.2 }}              // slight, lively overshoot
transition={{ type: "spring", stiffness: 100, damping: 10, mass: 0.75 }} // physics form
```

Pull repeated spring configs into a constant. When a spring looks wrong — jittery, overshooting oddly — **raise `damping`**; that fixes it most of the time. Lower `mass` makes it track an input more tightly (a cursor follower wants `mass: 0.1`).

**`MotionConfig`** sets a default transition for a whole subtree, so a component reads as one entity instead of a pile of individually-tuned parts:

```jsx
<MotionConfig transition={{ type: "spring", duration: 0.5, bounce: 0.2 }}>…</MotionConfig>
```

## AnimatePresence

```jsx
<AnimatePresence mode="popLayout" initial={false} custom={direction}>
  <motion.span
    key={state}          // REQUIRED
    custom={direction}   // pass again, or the exiting element reads stale props
    initial={{ opacity: 0, y: -25 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: 25 }}
    transition={{ type: "spring", duration: 0.3, bounce: 0 }}
  />
</AnimatePresence>
```

- **A `key` is mandatory.** Without it the component never unmounts and the exit never fires. When an exit animation does nothing, check the key first.
- **`mode="wait"`** — the old element leaves completely before the new one enters. For icon swaps (copy → checkmark) and morphing one rich state into another.
- **`mode="popLayout"`** — old and new animate simultaneously while siblings reflow around them. The right default for state swaps inside a button, step transitions, and crossfades. **If an exit animation looks broken, try changing `mode` before anything else.**
- **`initial={false}`** skips the mount animation, so a state swap doesn't animate on first paint.
- **An exiting element's props are stale.** It has already been removed from the tree, so it can't see the newest state. Pass `custom` to *both* `AnimatePresence` and the `motion` element to feed it fresh data — this is what makes direction-aware slides work.

### Variants

Named target sets, reusable across `initial`/`animate`/`exit`. Their real power is the function form, which receives `custom`:

```jsx
const variants = {
  initial: (direction) => ({ x: `${110 * direction}%`, opacity: 0 }),
  active:  { x: "0%", opacity: 1 },
  exit:    (direction) => ({ x: `${-110 * direction}%`, opacity: 0 }),
};

<motion.div variants={variants} initial="initial" animate="active" exit="exit" custom={direction} />
```

Store the direction in state (`setDirection(1)` on next, `-1` on back) at the same time you change the step.

## Layout and shared-element animations

The `layout` prop is the library's most powerful feature and the reason its animations feel native.

- **`layout`** animates *any* layout change — position, size, `flex-direction`, `justify-content`. For layout animations you change the element's **actual styles** (className or inline), not the `animate` prop; Motion measures before and after and interpolates.
- Add `layout` to **neighbouring elements too**, or they'll jump while the animating one glides.
- **`layoutId`** connects two different elements: when one mounts carrying the same `layoutId` as one that just unmounted, Motion morphs between them. Tab indicators, App Store card → detail, button → popover, images flying into a bin.
- **You can't steer a shared layout animation.** To add motion on top, animate the **parent** and let the children come along: `<motion.div animate={{ y: 73 }} transition={{ delay: 0.13 }}>`.
- **Always set an animated `border-radius` as an inline pixel value** — `style={{ borderRadius: 12 }}`. Layout animations work by scaling, which distorts corners; Motion corrects for this only when the radius is in pixels, not from a class or a `rem` value.

Expect friction on complex cases — distortion, elements that won't line up. That's the magic tax. [Inside Framer's Magic Motion](https://www.nan.fyi/magic-motion) explains the mechanism if you need to reason about it.

## Animating height

Motion can animate a fixed height to `auto`, but **not `auto` → `auto`** — which is what dynamic content actually needs. Measure it:

```jsx
import useMeasure from "react-use-measure";

const [ref, bounds] = useMeasure();

<motion.div animate={{ height: bounds.height ? bounds.height : null }}>
  <div ref={ref} className="inner">{content}</div>
</motion.div>
```

- **The `ref` and the `animate={{ height }}` must be on different elements.** On the same one, the animated height sticks and the element stops reacting to content changes.
- **Put the padding on the inner element** so the measurement includes it.
- `bounds.height` is `0` on first render; falling back to `null` means `auto` and avoids a layout shift.
- `useMeasure` is a `ResizeObserver` wrapper — hand-rolling one is a few lines if you'd rather not add the dependency.

## Motion values

Motion values update **outside React's render cycle**, so a value can change 60 times a second without a single re-render. Use them for anything high-frequency — pointer tracking above all. The React-state version of a cursor follower re-renders on every mouse move; the motion-value version doesn't re-render at all.

```jsx
const x = useMotionValue(0);                                  // .set() / .get()
<motion.div style={{ x }} />                                  // x/y map to translateX/translateY
```

| Hook | Use it for |
| --- | --- |
| `useMotionValue` | The value must track an input **1:1** — drag-to-dismiss scale, anything where a spring would feel disconnected from the finger. |
| `useSpring` | Almost everything else. A raw motion value updates instantly and feels lifeless; a spring makes the same interaction feel alive. |
| `useTransform` | Map one motion value's range onto another: `useTransform(y, [0, 300], [1, 1.5])`. The function form transforms the output instead — useful for animating a displayed number, and it stays subscribed so the rendered text keeps up. |
| `useMotionTemplate` | Build a **reactive string** from motion values — a motion value dropped into a plain template literal is dead. This is how you animate `clipPath`, `filter`, or any composite string. |

```jsx
const label = useTransform(angle, (v) => `${Math.round(v)}°`);          // function form
const clip  = useMotionTemplate`inset(0px ${clipValue}% 0px 0px)`;      // tagged template
```

`useSpring` genuinely changes how an interaction feels — the difference between a graph that follows your cursor and one that merely tracks it. Don't skip it to save a hook.

## Gestures

```jsx
<motion.div drag dragConstraints={boxRef} dragMomentum={false} whileTap={{ scale: 0.97 }} />
```

`drag` keeps momentum on release by default, which feels natural for a card being flung and wrong for a simple reposition — turn it off with `dragMomentum={false}`. `dragConstraints` takes a ref and bounds the element to it.

## Accessibility

- `useReducedMotion()` branches values in a component; `<MotionConfig reducedMotion="user">` handles a whole app by animating only opacity and background.
- Reduced motion means **gentler, not none** — keep opacity and color, drop the movement.
- If you fake a placeholder with a real element (see the feedback popover), keep the input's actual `placeholder` attribute for screen readers and `aria-hidden` the fake one.

## Debugging the magic

| Symptom | Cause |
| --- | --- |
| Exit animation doesn't play | Missing `key`, so the component never unmounts. Then: wrong `mode`. |
| Direction-aware slide always goes the same way | The exiting element has stale props — pass `custom` to both `AnimatePresence` and the element. |
| Border radius warps during a morph | Radius came from a class or `rem`. Move it to inline `style={{ borderRadius: 12 }}`. |
| Height animation freezes or jumps | `ref` and `animate={{ height }}` are on the same element, or the first-render `0` isn't falling back to `null`. |
| Neighbouring elements jump during a layout animation | They need `layout` too. |
| A `useMotionTemplate`-less string never updates | Motion values aren't reactive inside plain template literals. |
| Spring looks jittery or wild | Raise `damping`. |
| Both elements visible at once when switching fast | A known `AnimatePresence` bug; if you can't work around it, `11.0.10` predates it. |
| Animation runs on first paint when it shouldn't | Add `initial={false}` to `AnimatePresence`. |

## Imperative animation

`useAnimate()` gives you `[scope, animate]` for low-level, selector-based control. It's more powerful and much harder to maintain — Emil almost never uses it. Stay declarative unless you're orchestrating many elements across events.
