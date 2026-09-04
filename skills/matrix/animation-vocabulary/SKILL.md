---
name: animation-vocabulary
description: Reverse-lookup glossary that turns a vague description of a web animation or motion effect into its exact term ("the bouncy thing when a popover opens" → Pop in; "the iOS rubber-band scroll" → Rubber-banding; "one shape turning into another" → Morph). Use when the user asks "what's it called when…", or describes a motion effect without knowing its name and wants the right word to prompt an AI or designer with. For naming an effect, not designing or building one. Terms are drawn from the Animations on the Web course (animations.dev).
metadata:
  short-description: Name a web animation effect from a loose description
---

# Animation Vocabulary

Turn a vague description of a motion or effect into the precise term, so the user knows what to ask for. The glossary is drawn from the *Animations on the Web* course ([animations.dev](https://animations.dev/)).

## Quick Start

The user describes an effect loosely. You return the matching term(s) in this format:

```
**Stagger** — Animate several items one after another with a small delay between each, creating a cascade.
```

If several terms could fit, list the best match first, then 1–2 alternates with a one-line note on how they differ.

## Instructions

1. **Read for intent, not keywords.** Users describe what they *see* or *feel* ("springy", "slides off", "draws itself in", "grows out of the button"), not the technical name. Map the sensation to the glossary below.
2. **Quote the glossary verbatim.** Its descriptions are authoritative — use them as-is, don't paraphrase.
3. **Disambiguate close terms.** When two compete (*Crossfade* vs *Shared element transition*, *Pop in* vs *Bounce*, *Layout animation* vs *Shared layout animation*, *`useMotionValue`* vs *`useSpring`*), contrast them so the user can pick.
4. **When nothing matches exactly,** name the closest term and say plainly it's an approximation, or describe the effect in the glossary's vocabulary (e.g. "that's a *stagger* of *pop-in* entrances").
5. **Stay within this glossary.** If a term genuinely isn't here, say so rather than inventing one — though you may explain the concept using these words.
6. **Keep it tight.** A naming question wants a name, not an essay. Lead with the term; expand only if asked.

## Examples

**Example 1 — feel-based**
User: "What's it called when a popover seems to grow out of the button you clicked instead of from its middle?"
Output:
```
**Origin-aware animation** — An element animates out of its trigger (a popover growing from the button that opened it) instead of from its own center, which is the CSS default.
```

**Example 2 — disambiguation**
User: "The thing where one thing turns into another."
Output:
```
**Morph** — One shape smoothly turns into another shape while staying on screen, e.g. the Dynamic Island.

Close alternates:
- **Crossfade** — if the two states simply dissolve over each other in the same spot.
- **Shared element transition** — if an element travels and transforms from one position/size into another (thumbnail → full view).
```

**Example 3 — physics feel**
User: "That iOS scroll where it resists and snaps back when you pull too far."
Output:
```
**Rubber-banding** — A surface stretches past its natural edge with rising resistance the further you pull, then snaps back on release.
```

## Glossary

### Easing & timing

- **Easing** — The rate at which something changes over time; the single most important part of an animation, able to make a bad one look great or a good one look wrong.
- **`ease-out`** — Starts fast and decelerates to a gentle stop; feels responsive; the workhorse for elements entering or exiting the screen.
- **`ease-in`** — Starts slow and speeds up into the end; feels sluggish and unnatural, generally avoided on UI.
- **`ease-in-out`** — Starts slow, speeds up, slows down (a car accelerating then braking); for elements that move or morph while already on screen.
- **`ease`** — An asymmetric curve that starts faster and ends slower; elegant for gentle hover/color/opacity transitions; the CSS default.
- **`linear`** — Constant speed, no acceleration; robotic and lifeless, only right for constant motion (marquee, timer, spinner, steady rotation, hold-to-delete).
- **Custom easing curve / `cubic-bezier`** — A hand-tuned curve, usually stronger than the built-in named ones, defined from four control-point values.
- **Symmetric vs asymmetric curve** — Symmetric eases in and out equally (can feel slow); asymmetric front-loads or back-loads the motion and feels more alive.
- **Duration** — How long an animation runs; inseparable from easing, and scaled to element size, distance, and frequency of use.
- **Perceived performance / perception of speed** — How fast an interface *feels* regardless of real time; a faster spinner or a seamless transition makes an app feel quicker.
- **Trackability threshold** — The point below which an animation is too fast for the eye to follow; too fast is as bad as too slow.
- **Frequency of use** — How often a user sees an animation; the key factor in whether to animate at all (high frequency → little or no motion).

### Springs & physics

- **Spring animation** — Motion modeled on a physical spring (mass, tension/stiffness, damping), with no fixed duration, so it feels organic and alive.
- **Bounce** — A springy overshoot at the end of motion; playful in small doses, best defaulted to zero, and needs to be larger on smaller elements to read.
- **Perceptual duration** — For a spring, the time it *feels* finished even while subtle residual movement continues.
- **Stiffness / damping / mass** — The physical parameters that shape a spring; higher damping settles faster and less springy.
- **Interruptibility / momentum** — An in-flight animation redirected mid-motion carries its current velocity into the new target instead of jumping; a property of springs and CSS transitions, not keyframes.
- **`linear()`** — A CSS function used to *approximate* a spring curve (only an approximation — real springs need JS).

### Entrances, exits & physicality

- **Pop in / scale-in** — An element grows into place from a near-full starting scale (0.9–0.95, never 0) with opacity, so it feels like it was "always almost there."
- **Scale-from-zero (anti-pattern)** — Animating from `scale(0)`, which looks like the element came from nowhere; avoided.
- **Press feedback / scale-on-press** — Briefly shrinking a control (`scale(0.97)`) on press so it feels physically depressed; felt, not seen.
- **The lift** — A hover effect that raises a card; applied to a child/wrapper so the moving element doesn't slip out from under the cursor.
- **Hover flicker (flicker loop)** — An infinite lift-and-drop loop when a hover translate moves the element out from under the pointer, dropping the hover state.
- **Blur transition (motion blur)** — A small `filter: blur()` during motion that fills the gap between two states so the eye reads one smooth transition instead of two objects.
- **Stagger** — Sequencing a group's animations with incremental delays to create a cascade; varied by importance so it doesn't feel mechanical.
- **Orchestration** — Deliberately sequencing multiple elements' animations into a coordinated "wave" rather than everything at once.
- **Layered entry (anti-pattern)** — Stacking two entrances (parent slides in, then children trickle in); avoided in favor of "one entrance per container."

### Spatial awareness & navigation

- **Spatial consistency / spatial awareness** — Making the interface feel like one coherent space: exit direction matches entry, navigation maps forward = left / back = right.
- **Object permanence (in UI)** — The principle that an element should visibly travel between states rather than vanish and reappear from nowhere.
- **Origin-aware animation** — Scaling an element in from the point it was triggered (a dropdown from its trigger's edge), not from its center.
- **Direction-aware animation** — Enter/exit direction that adapts to the interaction direction (menu content sliding in from the side you came from).
- **Crossfade** — One view dissolves out while the next dissolves in with a brief overlap, often with a small directional shift and blur; communicates change without the weight of a slide.
- **Morph / morphing** — One element smoothly changing shape or size while staying on screen (Dynamic Island, feedback popover).
- **Shared element transition** — An element visually morphs/expands from a smaller instance to a larger one (thumbnail → full view) so the eye tracks the same object across states.

### Framer Motion / layout

- **Layout animation** — Automatically animating an element between its old and new layout (position/size) across renders, including CSS-unanimatable properties like `flex-direction`.
- **Shared layout animation (`layoutId`)** — Connecting two separate elements with the same id so the library morphs one into the other across mount/unmount (tab indicator, App Store card, trash "throw").
- **`AnimatePresence`** — The wrapper that keeps a component mounted long enough to play its exit animation when it's removed.
- **`popLayout` mode** — An `AnimatePresence` mode that pops the exiting element out of layout flow so siblings reflow in parallel with the exit (crossfade-like).
- **`wait` mode** — An `AnimatePresence` mode that fully animates the old element out before the new one animates in (icon swaps, rich state morphs).
- **Variants** — Named, reusable sets of animation targets referenced by string; can be functions of a `custom` value for direction-aware motion.
- **Motion value** — A value that updates outside React's render cycle for re-render-free 60fps animation (`useMotionValue`, `useSpring`, `useTransform`).
- **Auto-height animation** — Smoothly growing/shrinking a container by measuring its content and animating to that height (since `auto` → `auto` can't animate).

### SVG

- **Line-drawing / self-drawing stroke** — Revealing a stroke as if it's being drawn, by animating `stroke-dashoffset` with a dash as long as the whole path.
- **`stroke-dasharray` / `stroke-dashoffset`** — The dash-and-gap pattern of a stroke, and the offset that shifts it — the two properties behind line-drawing.
- **Path morphing** — Animating an SVG path's `d` between two shapes of the same point structure so one drawing becomes another.
- **`viewBox`** — The SVG "camera" defining the visible coordinate region and enabling responsive scaling.
- **`transform-box`** — Controls what an SVG element's `transform-origin` is relative to (`fill-box` = its own bounding box, `view-box` = the whole viewBox).

### Gestures & touch

- **Rubber-banding** — A surface stretching past its natural edge with rising resistance, then snapping back on release (iOS overscroll, over-drag).
- **Momentum dragging** — Dragging that keeps moving after release, decaying naturally, instead of stopping dead.
- **Drag-to-dismiss** — A gesture where drag distance maps directly (via a motion value) to an element's scale/position to dismiss it.
- **Follow-the-cursor** — An element that trails the mouse, usually via a spring so it has momentum instead of tracking rigidly.
- **Hover intent / hover debounce** — Requiring the pointer to dwell briefly (~100ms) before triggering, to avoid accidental activation.
- **Two-tap (touch) pattern** — On touch devices, the first tap plays the hover state and the second plays the click, compensating for the missing hover.

### Performance & accessibility

- **Hardware acceleration / GPU offload** — Animating `transform`, `opacity`, or `clip-path` so the work runs on the GPU and stays smooth regardless of main-thread load.
- **Layout / Paint / Composite** — The three browser rendering steps; cheap animations touch only Composite (which is why you animate `transform`/`opacity`).
- **`will-change`** — A hint that promotes an element to its own GPU layer (fixing 1px transform shift and jank) — added only once dropped frames appear.
- **Reduced motion** — Honoring the user's `prefers-reduced-motion` preference by making animations gentler (opacity/color, no movement) — not deleting them outright.

### Craft & process

- **Feeling (of an animation)** — Using speed and easing to convey a brand's personality (premium, edgy, fast) the way fonts and color do.
- **Cohesion / single entity** — Tuning all of a component's sub-animations to a shared timing feel so it reads as one object.
- **Taste** — The trained (not innate) ability to tell good animation from bad and justify why; the real differentiator in an age of AI-generated code.
- **Animations as proof of care** — Motion that's invisible in screenshots and non-default, used to demonstrate craft and build trust.
- **Micro-interaction** — A small, easily-missed animated response or loop that confirms an action or adds a moment of delight.
