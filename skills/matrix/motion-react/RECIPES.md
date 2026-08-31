# Motion for React Recipes

The components built in the Framer Motion module. Each is a small stack of the primitives in [SKILL.md](SKILL.md) — read them for the technique, not the markup.

## Animated button state (loading → success)

The login button that swaps its own label. `popLayout` so the outgoing label leaves while the new one arrives and the button resizes around them; `initial={false}` so nothing animates on first paint.

```jsx
const buttonCopy = {
  idle: "Send me a login link",
  loading: <Spinner size={16} />,
  success: "Login link sent!",
};

<button disabled={buttonState === "loading"}>
  <AnimatePresence mode="popLayout" initial={false}>
    <motion.span
      key={buttonState}
      transition={{ type: "spring", duration: 0.3, bounce: 0 }}
      initial={{ opacity: 0, y: -25 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 25 }}
    >
      {buttonCopy[buttonState]}
    </motion.span>
  </AnimatePresence>
</button>
```

Enter from above, exit below — one continuous downward motion, as if the labels are on a reel. Generalise it by lifting the variants into a reusable `<AnimatedState>` wrapper.

For a two-state icon swap (copy → checkmark) use **`mode="wait"`** instead, so the checkmark doesn't arrive before the copy icon has left.

## Dynamic height

The Family-drawer problem: content changes, height must follow, and Motion can't do `auto` → `auto`.

```jsx
const [elementRef, bounds] = useMeasure();

<motion.div animate={{ height: bounds.height ? bounds.height : null }} className="element">
  <div ref={elementRef} className="inner">   {/* padding lives here */}
    {content}
  </div>
</motion.div>
```

The `ref` and the animated height must be on different elements — otherwise the outer div keeps whatever height it was animated to and never reacts again. `null` on the first render means `auto`, which avoids a layout shift.

## Multi-step component

Steps slide in from the side, the container's height follows, and the direction flips depending on which button you pressed.

```jsx
const [currentStep, setCurrentStep] = useState(0);
const [direction, setDirection] = useState();
const [ref, bounds] = useMeasure();

<MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
  <motion.div animate={{ height: bounds.height }} className="multi-step-wrapper">
    <div className="multi-step-inner" ref={ref}>
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <motion.div
          key={currentStep}
          variants={variants}
          initial="initial"
          animate="active"
          exit="exit"
          custom={direction}
        >
          {content}
        </motion.div>
      </AnimatePresence>

      <motion.div layout className="actions">
        <button onClick={() => { setDirection(-1); setCurrentStep((p) => p - 1); }}>Back</button>
        <button onClick={() => { setDirection(1);  setCurrentStep((p) => p + 1); }}>Continue</button>
      </motion.div>
    </div>
  </motion.div>
</MotionConfig>
```

```jsx
const variants = {
  initial: (direction) => ({ x: `${110 * direction}%`, opacity: 0 }),
  active:  { x: "0%", opacity: 1 },
  exit:    (direction) => ({ x: `${-110 * direction}%`, opacity: 0 }),
};
```

Four things carry this component:

- **`custom` on both** `AnimatePresence` and the step. The exiting step is already out of the tree and its props are stale, so without this it always leaves in the same direction no matter which button you pressed.
- **`layout` on the buttons** so they ride the height change instead of jumping.
- **`useMeasure`, not magic numbers** — the height comes from the content.
- **`MotionConfig`** so the slide, the height, and the buttons share one transition and the whole thing reads as a single object.

`110%` rather than `100%` clears the container completely.

## Feedback popover (button morphs into a form)

```jsx
<motion.button layoutId="wrapper" style={{ borderRadius: 8 }}>
  <motion.span layoutId="title">Feedback</motion.span>
</motion.button>

<AnimatePresence>
  {open ? (
    <motion.div ref={ref} layoutId="wrapper" style={{ borderRadius: 12 }}>
      <motion.span aria-hidden layoutId="title" className="placeholder">Feedback</motion.span>

      <AnimatePresence mode="popLayout">
        {formState === "success" ? (
          <motion.div
            key="success"
            initial={{ y: -32, opacity: 0, filter: "blur(4px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            transition={{ type: "spring", duration: 0.4, bounce: 0 }}
          />
        ) : (
          <motion.form
            key="form"
            exit={{ y: 8, opacity: 0, filter: "blur(4px)" }}
            transition={{ type: "spring", duration: 0.4, bounce: 0 }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  ) : null}
</AnimatePresence>
```

**The trick is an illusion.** The grey "Feedback" text inside the popover is not the textarea's placeholder — it's a separate span sharing `layoutId="title"` with the button's label, so the button's own text appears to become the placeholder. A real placeholder attribute could never do that. Keep the textarea's actual `placeholder` for screen readers and hide it with `opacity: 0`; `aria-hidden` the decorative span.

Two `layoutId`s (`wrapper`, `title`) do all the morphing. Inline pixel `borderRadius` on both states, or the corners distort. `mode="popLayout"` lets the form leave while the success state arrives — the fix when a swap like this looks broken. The blur on enter and exit softens the whole thing.

Wire up `Escape` to close and `Cmd/Ctrl + Enter` to submit.

## Trash interaction (shared layout + parent motion)

Selected images fly into a bin and stack inside it.

- Grid images and bin images are **different elements** sharing a per-image `layoutId` (`` `image-${image}` ``) — Motion moves one into the other. Rotate each stacked image by its index for the scattered look.
- **You can't steer a shared layout animation**, so the drop is faked by animating the **parent** the bin images live in, and letting them follow:
  ```jsx
  <motion.div animate={{ y: 73 }} transition={{ delay: 0.13 }}>…</motion.div>
  ```
- The toolbar and the bin get their own `AnimatePresence` with a blur-and-scale enter/exit:
  ```jsx
  initial={{ opacity: 0, filter: "blur(4px)", scale: 1.2 }}
  animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
  exit={{ opacity: 0, filter: "blur(4px)", scale: 1.2 }}
  ```
- **Unselected images must not vanish instantly.** Give them a fast exit only when they weren't selected: `exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.05 } }}`.
- **Images passing in front of the bin** is a z-order problem solved with timing: fade the bin's front panel in with `duration: 0` and `delay: 0.175`, just as the images arrive.
- One `MotionConfig` (`{ type: "spring", duration: 0.5, bounce: 0.2 }`) tunes the whole interaction from a single place.

## Cursor follower

```jsx
const SPRING = { mass: 0.1 };
const x = useSpring(0, SPRING);
const y = useSpring(0, SPRING);
const opacity = useSpring(0);

<div
  onPointerMove={(e) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    x.set(e.clientX - bounds.left - 24);   // 24 = half the element, to centre on the cursor
    y.set(e.clientY - bounds.top - 24);
  }}
  onPointerEnter={() => opacity.set(1)}
  onPointerLeave={() => opacity.set(0)}
>
  <motion.div style={{ x, y, opacity }} />
</div>
```

No state, no re-renders, less code than the `useState` version — and it feels better. **`mass: 0.1`** makes the spring track the cursor tightly; the default lags too far behind. Tune the config to the surroundings; there's no universal one.

Add `const scale = useTransform(y, [0, 300], [1, 1.5])` to grow the follower as it moves down the container.

## Interactive graph

A line graph that draws itself toward the cursor (Linear's features page).

```jsx
const clipPathSpring = useSpring(0, { damping: 18 });
const clipPathTemplate = useMotionTemplate`inset(0px ${clipPathSpring}% 0px 0px)`;

function onPointerMove(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const distanceFromRight = Math.max(rect.right - e.clientX, 0);
  clipPathSpring.set(Math.min((distanceFromRight / rect.width) * 100, 100));
}

<motion.svg style={{ clipPath: clipPathTemplate }} />
```

It isn't drawing, it's **unclipping** — `inset` from the right, exactly the CSS technique, driven by a spring. `useMotionTemplate` is mandatory: a motion value inside a plain template literal never updates. The default spring looks buggy here; `damping: 18` settles it.

Two details that finish it:

- **Reset when the user leaves.** A component's default state is its most beautiful state, and an empty graph card left behind looks broken. Set the value back to `0` on a 1s timeout in `onPointerLeave`, storing the id in a ref and clearing it in `onPointerEnter` so a quick re-entry doesn't wipe the graph.
- **Use a different spring for the reset** than for the tracking — the snap back at tracking stiffness feels too fast. Swap the config on an `isHovering` state.

## App Store card → detail

- Every corresponding pair gets a matching `layoutId`: `card-${title}`, `image-${title}`, `title-${title}`, `description-${title}`, `button-${title}`.
- The opened card is `position: fixed` with `inset: 0` — a **real style change**, since layout animations interpolate actual layout, not `animate` values.
- Separate `AnimatePresence` blocks for the overlay and the card, so the overlay can leave fast (`exit={{ opacity: 0, transition: { duration: 0.05 } }}`).
- The long description that only exists in the open state gets `layout` plus its own opacity fade, with a very short exit so it doesn't linger while the card shrinks.
- Inline pixel `borderRadius` everywhere, including on the images.
- Dismiss on outside click (`useOnClickOutside`) and on `Escape`.

## Tab highlight

The whole effect is one element rendered only for the active tab:

```jsx
{activeTab === tab ? (
  <motion.div layoutId="tab-indicator" className="absolute inset-0 rounded-lg bg-black/5" />
) : null}
```

Because it unmounts and remounts under the same `layoutId`, Motion slides it. Put `layout` on the `<li>`s too if the tabs themselves move. Drive it from `onMouseOver` **and** `onFocus` so it follows keyboard navigation.

## Scroll-triggered reveal

`useInView` returns a boolean for whether an element is on screen:

```jsx
const isInView = useInView(ref, { once: true, margin: "100px" });
```

`once` stops it re-firing, `margin` fires it when 100px of the element is visible. If Motion isn't already in the bundle, use the Intersection Observer API instead — this alone isn't worth the dependency.
