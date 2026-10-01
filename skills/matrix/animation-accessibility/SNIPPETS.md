# Reduced-Motion Snippets

Copy-ready recipes for the cases that need a specific mechanism rather than an easing swap. From the *Animations on the Web* course ([animations.dev](https://animations.dev/)).

## Smooth scrolling

Scroll-behavior is motion the user didn't ask for, so opt *in* under `no-preference` rather than opting out under `reduce`. Written this way, the accessible behavior is the default even in browsers that don't match either query:

```css
@media (prefers-reduced-motion: no-preference) {
  html {
    scroll-behavior: smooth;
  }
}
```

## Autoplaying images

An animated GIF or AVIF autoplays with no user control at all. `<picture>` swaps in a static frame under `reduce` — no JavaScript, and the browser never downloads the animated file:

```html
<picture>
  <!-- Animated versions -->
  <source
    srcset="animated.avifs"
    type="image/avif"
    media="(prefers-reduced-motion: no-preference)"
  />
  <source
    srcset="animated.gif"
    type="image/gif"
    media="(prefers-reduced-motion: no-preference)"
  />
  <!-- Static fallback -->
  <img src="static.png" alt="" />
</picture>
```

## Autoplaying video

Under `no-preference` the video autoplays. Under `reduce` it stays paused and gets a control so the user can start it deliberately. Vanilla, and easily adapted to any framework:

```html
<figure>
  <div>
    <video controls muted loop>
      <source src="video.mp4" type="video/mp4" />
    </video>
    <button type="button" hidden aria-live="polite">Play</button>
  </div>
</figure>
```

```js
const btn = document.querySelector("button");
const video = document.querySelector("video");

const noMotionPreference = window.matchMedia("(prefers-reduced-motion: no-preference)");

const initVideo = () => {
  // Swap the native controls for our own so the button label can report state.
  video.removeAttribute("controls");
  btn.hidden = false;

  // Autoplay only when the user has expressed no preference for reduced motion.
  if (noMotionPreference.matches) {
    video.setAttribute("autoplay", true);
    btn.innerText = "Pause";
  }
};

btn.addEventListener("click", () => {
  if (video.paused) {
    video.play();
    btn.innerText = "Pause";
  } else {
    video.pause();
    btn.innerText = "Play";
  }
});

initVideo();
```

The button ships `hidden` so it never appears before `initVideo()` runs — otherwise a control with no handler flashes on load.

## Looping animation: pause on a hero frame

Don't just stop a loop — a paused animation sits on frame 0, which is usually its least representative state (an empty chart, a collapsed shape). A **negative `animation-delay` seeks into the timeline**, so pausing lands on a frame you chose:

```css
.animation {
  animation: shake 0.2s infinite;
}

@media (prefers-reduced-motion: reduce) {
  .animation {
    animation-play-state: paused;
    /* Pauses on the frame at 0.4s. Try different values and pick the best-looking frame. */
    animation-delay: -0.4s;
  }
}
```

Vercel does this on their [rendering](https://vercel.com/products/rendering) page: under reduced motion the animation holds on a frame from the middle of the loop, so the visual still reads.

## Dependency-free `useReducedMotion`

If you're not using Framer Motion, the hook is short. Read `matchMedia` inside the effect so it never runs during server rendering, and sync once on mount so a user who already set the preference gets the reduced variant:

```tsx
import { useState, useEffect } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  // Starts false so server and client markup match, then syncs on mount.
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(QUERY);
    setPrefersReducedMotion(mediaQuery.matches);

    const listener = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, []);

  return prefersReducedMotion;
}
```

Because the first render is always `false`, don't let the value gate *mounting* — branch animation values only, or the reduced-motion user sees a flash of the animated variant.

## Worked example: a multi-step component

The generic case. A multi-step form slides horizontally between steps and animates its container height. Three separate things move, so all three need a reduced variant — and this is why a **second variant set** beats patching values inline:

```jsx
import { useState } from "react";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "motion/react";
import useMeasure from "react-use-measure";

export default function MultiStepComponent() {
  const [currentStep, setCurrentStep] = useState(0);
  const [direction, setDirection] = useState();
  const [ref, bounds] = useMeasure();
  const reducedMotion = useReducedMotion();

  return (
    <MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
      {/* 1. Height animation: skipped entirely — a growing container is movement. */}
      <motion.div animate={reducedMotion ? {} : { height: bounds.height }}>
        <div ref={ref}>
          <AnimatePresence mode="popLayout" initial={false} custom={direction}>
            <motion.div
              key={currentStep}
              /* 2. Slide → crossfade by swapping the whole variant set. */
              variants={reducedMotion ? reducedMotionVariants : variants}
              initial="initial"
              animate="active"
              exit="exit"
              custom={direction}
            >
              {/* step content */}
            </motion.div>
          </AnimatePresence>
          {/* 3. Layout animation on the actions row: off, it repositions the buttons. */}
          <motion.div layout={!reducedMotion} className="actions">
            {/* Back / Continue */}
          </motion.div>
        </div>
      </motion.div>
    </MotionConfig>
  );
}

const variants = {
  initial: (direction) => ({ x: `${110 * direction}%`, opacity: 0 }),
  active: { x: "0%", opacity: 1 },
  exit: (direction) => ({ x: `${-110 * direction}%`, opacity: 0 }),
};

// Same three states, opacity only — the step change stays legible, nothing moves.
const reducedMotionVariants = {
  initial: { opacity: 0 },
  active: { opacity: 1 },
  exit: { opacity: 0 },
};
```

The transferable shape: **one `useReducedMotion()` call, then audit every animating property in the component.** Movement usually hides in more than one place — a transform, a measured height, and a `layout` prop are three separate opt-outs, and missing any one leaves the "reduced" variant still moving.
