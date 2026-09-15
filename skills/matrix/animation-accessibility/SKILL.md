---
name: animation-accessibility
description: Reduced motion for web animation — ship every animation as two variants so motion never makes someone sick or distracted. Use when adding or reviewing `prefers-reduced-motion` handling; when deciding what an animation should become under reduced motion; when a page has autoplaying video, GIFs, looping animation, or smooth scrolling; or when wiring up `useReducedMotion` / `MotionConfig`. Triggers on — accessibility, a11y, prefers-reduced-motion, reduced motion, motion sensitivity, vestibular, motion sickness, dizzy, distracting animation, motion-safe, motion-reduce, useReducedMotion, MotionConfig, scroll-behavior, autoplay, autoplaying GIF, looping animation, animation-play-state, accessible animation.
metadata:
  short-description: Ship animations that respect reduced motion (animations.dev course)
---

# Accessible Animation

Animations are used to strategically improve an experience. **To some people, they degrade it.** Motion can [make people feel sick](https://www.a11yproject.com/posts/understanding-vestibular-disorders/) — vestibular disorders are real and common — or simply pull attention away from the task. That's not the experience you're building.

Distilled from Emil Kowalski's *Animations on the Web* course ([animations.dev](https://animations.dev/)). This skill covers **reduced motion**: reading the user's preference and deciding what each animation becomes when it's set.

## The preference

Most devices let users state a preference for animation, and browsers expose it through the `prefers-reduced-motion` media query:

- **`no-preference`** — the user has not set a preference. No change needed.
- **`reduce`** — the user has set a preference. Your animation must be altered.

Because the preference exists at the OS level, a user who set it once expects *every* site to honor it. There is no per-site opt-in to wait for.

## Gentler, not zero

**`reduce` does not mean "no animations."** Animations exist to make UI easier to understand; deleting them wholesale makes the interface *harder* to follow, which is the opposite of accessible. Animation should still convey meaningful information.

The transformation is: **remove the motion, keep the meaning.**

| Under `reduce` | Do |
| --- | --- |
| Movement — `transform`, `translate`, `scale`, position, layout | **Remove.** Nothing should move. |
| Meaning — `opacity`, `color`, `background-color` | **Keep.** These carry the state change without motion. |
| Autoplaying and looping animation | **Disable** — or pause it on a representative frame. |
| Purely decorative motion (an idle float, an ambient loop) | **Remove entirely.** It conveys nothing, and lingering motion falsely implies interactivity. |

So a modal that scales in becomes a modal that fades in. A sidebar that slides from `-100%` becomes a sidebar that fades. A multi-step form that slides horizontally between steps crossfades instead. The state change is still legible; nothing travels across the screen.

## Workflow

Follow this order — reduced motion is a second pass, not a constraint to design around:

1. **Build the animation.** Get it feeling right first.
2. **Adjust for `prefers-reduced-motion`.** Apply the table above. Test it with the preference on — [Chrome DevTools can emulate it](https://developer.chrome.com/docs/devtools/rendering/emulate-css#emulate_css_media_feature_prefers-reduced-motion) (Rendering panel → *Emulate CSS media feature prefers-reduced-motion*).
3. **Ship two variants.** One for `no-preference`, one for `reduce`.

You're done when every animation you touched has both variants and you have watched the `reduce` variant with emulation on. Reasoning about it is not the same as seeing it — the common failure is a "reduced" variant that still moves, because one `transform` was left behind in a shared class or a spring config.

## Implementation

### CSS

Swap the animation, don't delete it:

```css
.element {
  animation: bounce 0.2s;
}

@media (prefers-reduced-motion: reduce) {
  .element {
    animation: fade 0.2s;
  }
}
```

### Tailwind

`motion-safe:` and `motion-reduce:` variants map to the two media queries:

```html
<svg class="motion-safe:animate-bounce motion-reduce:animate-fade" viewBox="0 0 24 24">
  <!-- ... -->
</svg>
```

### Framer Motion — `useReducedMotion`

The hook returns `true` when the user prefers reduced motion, so you can branch individual values:

```jsx
import { useReducedMotion, motion } from "motion/react";

export function Sidebar({ isOpen }) {
  const shouldReduceMotion = useReducedMotion();
  const closedX = shouldReduceMotion ? 0 : "-100%";

  return <motion.div animate={{ opacity: isOpen ? 1 : 0, x: isOpen ? 0 : closedX }} />;
}
```

The same hook branches whole **variant sets**, which is cleaner than patching values one at a time — see the worked example in [SNIPPETS.md](SNIPPETS.md). It also gates the properties CSS can't reach: skip `animate={{ height }}` and pass `layout={false}` under `reduce`, since layout animations move things by definition.

### Framer Motion — `MotionConfig` (app-wide safety net)

`reducedMotion="user"` makes Framer Motion respect the preference everywhere below it, animating only `opacity` and `backgroundColor`:

```jsx
import { MotionConfig } from "motion/react";

<MotionConfig reducedMotion="user">{children}</MotionConfig>
```

**The default is `never`, so this does nothing until you set it.** Wrap your whole application and you stop having to remember per-component — a good baseline, with per-component `useReducedMotion` on top wherever the fade-only default loses meaning.

## Visuals: jump, don't tween

Anything that reads as an image or video — a visual metaphor explaining a concept — often *can't* be removed, because the motion is what carries the explanation.

Reduce it instead of deleting it: **jump between the frames rather than animating between them.** The user still gets every state of the sequence; nothing slides or morphs on screen.

## Snippets

[SNIPPETS.md](SNIPPETS.md) has copy-ready recipes for the cases with a specific mechanism:

- Smooth scrolling — enable only under `no-preference`
- Autoplaying images (GIF / animated AVIF) — static fallback via `<picture>`
- Autoplaying video — paused with visible controls under `reduce`
- Looping animation — pause it on a **hero frame** rather than frame 0
- Dependency-free `useReducedMotion` hook
- Worked example: reduced-motion variants for a multi-step component

---

For the surrounding decisions — whether to animate at all, easing, duration, springs — see the `animate` skill. For frame budget and GPU concerns, see `animation-performance`.
