---
name: debug-animation
description: Diagnose an animation that feels off, janky, or broken and name the exact cause before touching code — the diagnosis loop from the "Animations on the Web" course (animations.dev). Use when an animation feels wrong but the user can't say why, when motion is sluggish, robotic, cheap, flickery, or lifeless, when elements jump, snap, shift by a pixel, or skip their exit animation, or when a transition that "should work" doesn't fire. Triggers on — feels off, feels wrong, feels slow, feels cheap, feels robotic, lifeless, sluggish, janky, choppy, stutters, drops frames, jumps, snaps, flickers, shifts, "exit animation doesn't play", "animation doesn't fire", "animates from the wrong place", "looks bad but I don't know why", debug animation, fix this animation, why does this animation, animation bug, frame by frame, slow motion, scrub.
metadata:
  short-description: Diagnose why an animation feels wrong before fixing it (animations.dev)
---

# Debugging Animations

The diagnosis loop from Emil Kowalski's *Animations on the Web* course ([animations.dev](https://animations.dev/)). The job: turn "this feels off" into a named cause, then make the smallest fix that addresses it. **Never tweak values blindly** — randomly nudging durations produces a different animation, not a better one, and destroys the ability to tell what actually helped.

## The loop

1. **Reproduce it**, on the environment where it feels wrong. A gesture that's fine on a laptop can stutter on a phone; an opacity crossfade that's fine at 120Hz looks rough at 60Hz. Test on the real device (dev server by local IP) before concluding anything.
2. **Slow it down.** Most animations are too fast to diagnose by eye. Record the animation and scrub it frame by frame, or set DevTools' Animations panel playback to 10–25%. This is the single highest-leverage step — the flaw that's invisible at full speed (a late fade, a wrong origin, two states reading as separate objects) is obvious at quarter speed.
3. **Classify the symptom** using the tables below, and check causes in order — they're sorted by likelihood.
4. **Change one variable, re-record, compare.** Easing first, then duration — duration depends on the easing (a steep curve affords a longer duration), so tuning duration before the curve is settled is wasted work.
5. **Verify at full speed, then with fresh eyes.** An animation approved only in slow motion hasn't been approved. For anything shipping, replay it again the next day — Sonner's transitions were replayed daily for days before release; the flaws you're blind to tonight are visible tomorrow.

## Symptom → cause

### "It feels slow / sluggish"

| Check, in order | Fix |
| --- | --- |
| `ease-in` on the animation | Swap to a strong `ease-out` — `ease-in` starts slow, delaying the exact moment the user is watching. Same duration will instantly feel faster. |
| Built-in named easing (`ease-out`, `ease-in-out`) | Replace with a custom curve — built-ins accelerate too weakly, so motion feels flat and slow at any duration. |
| Duration over ~300ms on product UI | Cut it. A 180ms dropdown feels more responsive than a 400ms one. Only a very steep curve (Vaul's `cubic-bezier(0.32, 0.72, 0, 1)`) earns a long duration. |
| Animation on a high-frequency action (keyboard nav, shortcut toggle, constant hover) | Delete the animation. At 100+ uses/day any duration reads as lag — the fix is removal, not tuning. |
| A `delay` in the chain | Remove or shrink it; delays on interactive responses read as the UI hesitating. |

### "It feels robotic / lifeless / flat"

| Check, in order | Fix |
| --- | --- |
| `linear` easing on non-constant motion | Nothing in the physical world moves at constant speed. `ease-out` for enter/exit, `ease-in-out` for on-screen movement. `linear` only for marquees, spinners, and time-visualizing holds. |
| Curve too weak | Steepen it — when an animation feels flat, the curve is usually the problem, not the duration. |
| A duration-based ease on something that should feel alive (drag release, Dynamic-Island-style morph) | Use a spring. Fixed durations can't carry velocity or organic settle. A weird-feeling spring is usually fixed by increasing `damping`. |
| Uniform stagger (identical delay/distance per item) | Vary delay and distance by importance — the metronome effect is what feels mechanical. |

### "It feels cheap / off, but I can't say why"

| Check, in order | Fix |
| --- | --- |
| Entrance from `scale(0)` or a bare fade | Start from `scale(0.9–0.95)` + opacity — nothing real appears from nothing; a near-full start reads as "it was almost already there." |
| Wrong `transform-origin` | Popovers/dropdowns/tooltips scale from their **trigger**, not center. Use the library's origin variable (`--radix-*-transform-origin`, Base UI's `--transform-origin`). Slowed playback makes a wrong origin unmistakable. |
| Crossfade shows two distinct overlapping states | Add `filter: blur(2px)` during the transition — blur bridges the visual gap so the eye reads one transforming object instead of two swapped ones. |
| Sub-animations on different clocks | Unify the timing family. The Family drawer overrides Vaul's 500ms to 200ms so open, height, and crossfade feel like a single entity — one slow sub-animation breaks the whole component. |
| Enter and exit mismatched | Exit in the direction of entry, ~20% faster and simpler than the entrance — the user already decided; get out of the way. |
| Motion mismatched to personality | A playful app can bounce; a dashboard stays crisp. Sonner uses `ease` over the "correct" `ease-out` because elegance fit it better — feel can overrule the blueprint, but deliberately. |

### "It's janky / drops frames"

| Check, in order | Fix |
| --- | --- |
| Animating `width`/`height`/`margin`/`padding`/`top`/`left` | Move to `transform`/`opacity` — layout properties trigger Layout + Paint + Composite every frame; transforms composite only. |
| React state updating per frame (scroll/drag/rAF into `setState`) | Drive it with motion values or direct style writes — a re-render per frame is a frame dropped per frame. |
| CSS variable on a parent driving child transforms | Set `transform` directly on the element. Inherited variables recalc styles for every descendant — this lagged Vaul's drag past ~20 items. |
| Motion's `x`/`y`/`scale` shorthands while the main thread is busy | They run on rAF, not the compositor. Animate the full `transform` string, or move the animation to CSS/WAAPI (this fixed the Vercel dashboard tabs). |
| Animated `blur()` > 20px | Cap it at ~20px — blur cost explodes, especially in Safari. |

For the full frame-budget model and profiling workflow, hand off to the `animation-performance` skill.

### "It jumps / snaps / shifts"

| Check, in order | Fix |
| --- | --- |
| Element jumps when the animation is retriggered quickly (new toast, rapid toggle) | `@keyframes` restart from zero — they're not interruptible. Use CSS transitions or springs, which retarget from the current state with velocity. This was Sonner's stacking bug. |
| Exit animation never plays | The `AnimatePresence` child is missing a `key` (or `AnimatePresence` sits inside the conditional instead of around it). No key, no exit — it's the first thing to check. |
| Height snaps instead of animating | `height: auto` isn't animatable — measure it (`useMeasure`) and animate the pixel value, keeping the measured ref on the element that owns the padding, or the number lies. |
| 1px shift at animation start/end | `will-change: transform` — the browser is handing the element between CPU and GPU, which render slightly differently. |
| Content flashes to its final state before animating | The initial state arrives after first paint. Set it in CSS (or `@starting-style`) so the element is born in its hidden state. |

### "It fires when it shouldn't / flickers"

| Check, in order | Fix |
| --- | --- |
| Hover element oscillates between states | The hover animation moves the element out from under the cursor, ending the hover, dropping it back in. Move the transform to an inner child; the parent stays put under the cursor. |
| Hover states firing on phones | Touch taps trigger phantom hovers. Gate with `@media (hover: hover) and (pointer: fine)`. |
| Every tooltip in a row animates as the cursor sweeps | Once one tooltip is open, siblings open with no delay and no animation — target Base UI's `data-instant` with `transition-duration: 0ms`. |
| Animation replays every time it scrolls into view or on back-navigation | Intro and reveal animations run once. Unobserve after firing / persist a has-played flag. |

## When no table row matches

The animation may be *correct and wrong anyway* — built to spec but the spec is off. Re-derive the basics in order: should this animate at all (frequency of use)? → right easing family for the motion type? → duration matched to that easing and the element's size? If a reference exists (an app whose version feels right), record the reference and scrub both side by side — matching reality beats theorizing. And when a crossfade resists all tuning, a 2px blur is the sanctioned last resort.

## Related skills

Full-diff audit with a verdict → `review-animations`. Deep performance profiling → `animation-performance`. Motion-for-React API misfires → `motion-react`. Naming the effect you're looking at → `animation-vocabulary`.
