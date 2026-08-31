# Audit Categories

The rule catalog behind the audit, distilled from the *Animations on the Web* course ([animations.dev](https://animations.dev/)). Each category lists what to grep for, why it's a defect, the exact replacement value, and the severity to file it under.

Cite these values in plans. Never approximate a curve or a duration you could copy from here.

---

## 1. Purpose & frequency

The first question is never "is this animation good?" — it's "should this animate at all?"

**Frequency decides.**

| Frequency | Verdict |
| --- | --- |
| 100+/day — keyboard shortcuts, command-palette toggle, arrow-key list nav | **No animation. Ever.** |
| Tens/day — hover effects, sidebar and list navigation | Remove, or make instant |
| Occasional — modals, drawers, toasts | Standard animation |
| Rare / first-time — onboarding, feedback, celebration | A delight budget exists |

**Signals**

| Signal | Why | Severity |
| --- | --- | --- |
| Any transition on an element toggled by a keyboard shortcut | Repeated hundreds of times a day; motion makes the action feel slow, delayed and disconnected from the keypress. Raycast has no open/close animation, and that is the optimal experience | HIGH |
| A fading highlight that follows arrow-key or cursor selection | Looks smoother in a demo, but trails one step behind the cursor. Direct connection beats smoothness here — make it instant | HIGH |
| A hover transition on a row hit dozens of times a day | Even 200ms creates friction at that frequency | MEDIUM |
| Staggered dropdown or menu items | Feels cool the first time and slows every use after; users interact measurably faster with no item animation | MEDIUM |
| An animation whose only justification is "delight" on a daily-use surface | The initial delight fades and becomes a daily annoyance | MEDIUM |

**Every animation needs a purpose you can state in one sentence:** feedback, spatial consistency, state indication, preventing a jarring change, explanation, or — on rarely-seen surfaces only — delight. If everything animates, nothing stands out.

Marketing pages get more freedom: viewed less often, mostly non-interactive, and they're the packaging of the product. Long durations, one-shot intros and easter eggs are legitimate there and not in the product.

---

## 2. Easing & duration

Easing is the single biggest factor in whether an animation feels right. It can make a bad animation look great and a great one look bad.

| Situation | Curve |
| --- | --- |
| Entering or exiting the screen | `ease-out` |
| Moving or morphing while already on screen | `ease-in-out` |
| Hover, color, background, opacity | `ease` |
| Constant motion — marquee, spinner, timer, hold-to-delete, 3D rotation | `linear` |
| Default | `ease-out` |

**Signals**

| Signal | Why | Severity |
| --- | --- | --- |
| `ease-in` on any UI interaction | Starts slow, delaying the exact moment the user is watching, then accelerates into the stop — the opposite of how things settle. Identical durations feel dramatically slower | HIGH |
| A built-in named curve on a deliberate animation | Built-ins are almost never strong enough; their acceleration is too weak, so motion feels flat. AI reaches for them because they dominate training data. Treat them as *categories*, then pick a real cubic-bezier | MEDIUM |
| `linear` on anything that isn't constant motion | Nothing in the world moves at a constant speed; it reads as robotic and lifeless | HIGH |
| UI duration > 300ms with no stated reason | Product UI stays under ~300ms unless justified by size, travel distance, or a very steep curve | MEDIUM |
| Enter and exit given identical durations | The user has already decided to dismiss; exits should be shorter and often simpler | MEDIUM |
| A full-screen or large-travel element given a short duration | Duration scales with distance and size — a truck stops slower than a bicycle | MEDIUM |
| A symmetric `ease-in-out` on something the user just tapped | The slow start reads as lag between tap and response. An asymmetric curve keeps responsiveness and adds a quality settle | MEDIUM |
| `transition: all` | Animates properties you never intended, off the GPU | HIGH |

**Curves worth citing**

```css
--ease-out-quad:      cubic-bezier(0.25, 0.46, 0.45, 0.94);  /* button press */
--ease-out-quint:     cubic-bezier(0.23, 1, 0.32, 1);
--ease-out-expo:      cubic-bezier(0.19, 1, 0.22, 1);        /* strong: card hover, text reveal */
--ease-in-out-cubic:  cubic-bezier(0.645, 0.045, 0.355, 1);  /* on-screen back-and-forth */
--ease-in-out-circ:   cubic-bezier(0.785, 0.135, 0.15, 0.86);
--ease-vaul:          cubic-bezier(0.32, 0.72, 0, 1);        /* iOS sheet — extremely steep start */
```

The blueprint ships 16 curves sorted weakest to strongest per easing type. When an animation feels flat, the curve is too weak — not the duration.

**Duration budget**

| Element | Duration |
| --- | --- |
| Button press | ~150ms |
| Hover | 100–150ms (300ms feels swimmy) |
| Tooltip, small popover | 125–200ms |
| Dropdown, select | 150–250ms — 180ms reads as more responsive than 400ms |
| Modal, drawer | 200–500ms |
| Big element crossing the screen | up to ~1s |
| Marketing | Freer |

**Duration and easing are inseparable.** Vaul's enter animation is 500ms — far past the guideline — and doesn't feel slow because the curve is extremely steep at the start, front-loading the movement to mimic a spring's gentle ending. A weak curve must be shorter. Choose the easing first, then tune the duration to it. Too fast is as bad as too slow.

Perceived speed is often worth more than real speed: a faster spinner makes the app seem to load faster at identical load times.

---

## 3. Physicality & origin

| Signal | Fix | Severity |
| --- | --- | --- |
| Entrance from `scale(0)` | `scale(0.9–0.95)` + `opacity: 0`. Nothing appears from nothing; even a deflated balloon has a visible shape. A near-full start reads as "it was always almost there" | HIGH |
| `transform-origin: center` (the default) on a trigger-anchored popover, dropdown or tooltip | `var(--radix-dropdown-menu-content-transform-origin)` (Radix) or `var(--transform-origin)` (Base UI). It should come *from the button*, creating clear cause and effect. **Modals are exempt** — they appear centered | MEDIUM |
| Hover with nothing on `:active` | `transform: scale(0.97)` on `:active`, `transition: transform 150ms`. Hover with no press response feels dead, as if the action wasn't received | MEDIUM |
| `scale(0.9)` or lower on press | `scale(0.97)`. Press feedback should be **felt, not seen** — if you can clearly see the button shrink, it's too aggressive | MEDIUM |
| `hover:scale-105` or any hover scale above ~2% | `scale(1.02)`. 5% inflates the card like a balloon; only very tiny elements justify more | MEDIUM |
| `translateY` hover applied to the hover target itself | Move it to a child. The element lifts out from under the cursor → hover ends → it drops back under the cursor → infinite flicker loop. Keeping the lift on an inner element leaves the parent's hover zone intact | MEDIUM |
| Hardcoded pixel translate on a variable-height element | Use percentages — `translateY(100%)` always moves by the element's own height. This is how Sonner and Vaul position toasts and drawers, and it's less error-prone even when dimensions are fixed | LOW |

---

## 4. Interruptibility & springs

CSS **transitions** and **springs** retarget from their current value mid-flight. `@keyframes` restart from zero.

| Signal | Why | Severity |
| --- | --- | --- |
| `@keyframes` on toasts, toggles, accordions, drawers, or anything re-triggered while still playing | The exact Sonner bug: adding a second toast quickly made the first jump to its new position | HIGH |
| A spring driving something that must track a gesture 1:1 | A spring lags the finger; use a raw motion value for direct tracking | MEDIUM |
| Bounce on a press-to-close, a dashboard, or anything serious | Bounce communicates personality — more is playful, zero is professional. **Default to zero.** A slight bounce is earned at the end of a *drag*, because a drag applies force, like throwing a ball against a wall | MEDIUM |

Spring configuration, Apple/Motion style — perceptual duration plus bounce, easier to reason about than mass/tension/velocity:

```js
{ type: "spring", duration: 0.3, bounce: 0 }
{ type: "spring", duration: 0.5, bounce: 0.2 }
```

Real springs are impossible in pure CSS; `linear()` only approximates one. Springs come with a bundle-size cost — a real trade-off, and Vaul deliberately chose the smaller package over a more native feel.

Use `@starting-style` for an enter transition with no `mounted` state and no `useEffect`.

---

## 5. Performance

Sixty frames a second means every frame lands inside ~16.7ms. The browser renders in three steps — **Layout**, **Paint**, **Composite**. `transform` and `opacity` touch only Composite; `width`, `height`, `margin`, `padding`, `top` and `left` trigger all three.

| Signal | Fix | Severity |
| --- | --- | --- |
| Animating layout properties | `transform` / `opacity`. `scale` instead of `padding`, `translate` instead of `margin`. Exception: `position: absolute` or very few children may get away with it | HIGH |
| A CSS variable on a parent driving children's transforms, updated per frame | Set `transform` directly on the element. CSS variables are inheritable, so changing one recalculates styles for every descendant — this is what made Vaul's drag lag past ~20 list items | HIGH |
| `x` / `y` / `scale` shorthands on motion that runs while the page is busy | Animate the full `transform` string — the shorthands are not hardware-accelerated and run on the main thread via `requestAnimationFrame` | MEDIUM |
| rAF-driven motion during heavy work (page loads, large lists) | Move it to CSS or WAAPI, which stay smooth however busy the main thread is. Vercel's tab highlight dropped frames on shared-layout animation during navigation and was fixed exactly this way | MEDIUM |
| Animating through React state at 60fps | Update the style or a motion value directly; state updates re-render every frame | MEDIUM |
| Animated `blur()` above ~20px | Blur gets laggy fast, especially in Safari | MEDIUM |
| A 1px shift at the start or end of a transform animation | `will-change: transform` — the shift comes from the browser handing the animation between CPU and GPU | LOW |

`will-change` is a fix for observed jank, not a default. Don't sprinkle it.

---

## 6. Accessibility

Motion can [make people feel sick](https://www.a11yproject.com/posts/understanding-vestibular-disorders/) or pull attention away from the task. Ship every animation as two variants: one for `no-preference` and one for `reduce`.

| Signal | Fix | Severity |
| --- | --- | --- |
| Movement with no `prefers-reduced-motion` handling | Under `reduce`, animate `opacity` / `color` / `background-color` only and ensure nothing moves. **Reduced motion means gentler, not zero** — removing animation entirely reduces how understandable the UI is | MEDIUM |
| Autoplaying animation, GIF or video with no reduced-motion path | Disable autoplay; use a `<picture>` static fallback, or give the video controls and a play button | MEDIUM |
| An infinite loop under `reduce` | Pause on a representative frame — `animation-play-state: paused` with a negative `animation-delay` — rather than frame 0 | LOW |
| `scroll-behavior: smooth` applied unconditionally | Wrap it in `@media (prefers-reduced-motion: no-preference)` | LOW |
| Ungated `:hover` motion | Gate behind `@media (hover: hover) and (pointer: fine)`. Tapping a touch device fires the hover state, and that's not the intent 99% of the time. Tailwind v4 does this by default | MEDIUM |
| An interactive element smaller than 44×44px | Add a `::before` hitbox that's at least 44px without changing layout | MEDIUM |
| An essential explanatory animation | Don't delete it — jump between its key frames instead of tweening, so the meaning survives | MEDIUM |

In Motion, `useReducedMotion()` branches values and `<MotionConfig reducedMotion="user">` makes the whole app animate only opacity and background. The default is `never`, so it has to be set explicitly.

---

## 7. Cohesion, hierarchy & spatial consistency

| Signal | Fix | Severity |
| --- | --- | --- |
| Sub-animations of one component with unrelated durations and curves | Unify them so the component reads as a single entity — the Family Drawer overrides Vaul's 500ms to 200ms so opening and height changes feel like one thing | MEDIUM |
| Something that slides in from a direction and fades out | Exit direction matches entry. When a sidebar slides in from the left, the user's model is "this lives to the left"; fading out contradicts it. Sonner's toasts enter and exit the same way, which is what makes swipe-to-dismiss feel intuitive | MEDIUM |
| Back and Next animating the same direction | Forward = left, back = right. Animating against the action contradicts it | MEDIUM |
| A thumbnail that vanishes while a full-screen version fades in | Expand it from where it sits. This is object permanence — with no spatial link the brain loses continuity | MEDIUM |
| A parent entrance *plus* staggered children | **One entrance per container.** Slide the panel in with content already there; the user can start reading immediately | MEDIUM |
| Uniform stagger — identical delay, distance and easing per item | Vary by visual importance: the most important element leads and gets the most screen time, the least important can just fade without sliding. Uniform stagger has the same deadening effect on motion that `linear` has on easing | LOW |
| Stagger longer than ~80ms between items | Group entrances want 30–80ms; longer feels slow, and stagger is decorative so it must never block interaction | LOW |
| A full `translateX(100%)` slide inside a small container | Crossfade with a small directional hint — an 8px shift, opacity, and a light blur. Faster, calmer, and the eyes barely move | LOW |
| A crossfade that reads as two distinct objects however you tune it | Add ~2px of `filter: blur()` during the transition. Blur bridges the visual gap and tricks the eye into seeing one transformation instead of two states | LOW |
| Motion that fights the brand | Match personality: Vercel is about speed so its product motion is very fast or absent; Sonner uses `ease` and slightly longer durations because elegance mattered more than snappiness | LOW |

---

## 8. Missed opportunities

Additive, not corrective — report these separately so they don't compete with regressions. Every one must still pass the frequency and purpose tests in category 1.

- A pressable element with a hover state and nothing on `:active`.
- A toast, dialog, popover or drawer that appears instantly, where a sudden appearance feels off.
- A deliberate state swap — selecting items then confirming a delete, a form becoming a success state — where morphing makes the two states read as one object.
- A view that opens from a card but cross-fades in full-screen instead of expanding from it.
- Height that jumps between steps of a multi-step flow.
- Text whose change alters the consequence of the next click, where morphing the characters emphasizes rather than hides the change.
- A destructive confirm that fires instantly, where a hold-to-delete gives the user their time back — `clip-path` revealed with `linear`, snapping back fast with `ease-out` on release.
- A slow spinner, where speed alone improves perceived performance.
- On marketing pages only: scroll-triggered `clip-path` reveals, a hero whose varied timing lets the eye read in order, an explanatory animation replacing a static asset, or an easter egg for the users who find it.

---

## Exempt — don't file these

- `transform-origin: center` on a modal. Modals appear centered.
- `linear` on a marquee, spinner, timer, hold-to-delete or 3D rotation. Constant motion is exactly what `linear` is for.
- Long durations and one-shot intro animations on marketing pages.
- Bounce that a design note says was chosen for brand personality.
- `@keyframes` on something that genuinely can't be re-triggered mid-flight.
- Motion the codebase documents as a deliberate trade-off.
