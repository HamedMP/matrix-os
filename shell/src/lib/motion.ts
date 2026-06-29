"use client";

/**
 * Shared framer-motion variants for the mobile shell (spec 102).
 *
 * One implementation so app transitions, bottom-sheets and incidental UI all
 * move with the same emphasized easing. Everything degrades to an instant cut
 * under `prefers-reduced-motion` via `reducedMotion()`.
 */

import type { Transition, Variants } from "framer-motion";

/** iOS-style emphasized decelerate — mirrors `--ease-emphasized` in globals.css. */
export const EASE_EMPHASIZED: [number, number, number, number] = [
  0.32, 0.72, 0, 1,
];

/** True when the user has asked the OS to minimize motion (SSR-safe). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A near-instant transition used to collapse animations for reduced motion. */
export const instantTransition: Transition = { duration: 0 };

const baseTransition: Transition = {
  duration: 0.32,
  ease: EASE_EMPHASIZED,
};

/**
 * Resolve a transition, collapsing to instant when reduced motion is on.
 * Pass into `transition={reducedMotion(myTransition)}` at render time so the
 * preference is read on the client, not baked at module load.
 */
export function reducedMotion(transition: Transition = baseTransition): Transition {
  return prefersReducedMotion() ? instantTransition : transition;
}

/**
 * App switch: a new app slides up + fades in, the outgoing one fades + sinks.
 * Use with `<AnimatePresence>` around the active app surface.
 */
export const appEnter: Variants = {
  initial: { opacity: 0, y: 16, scale: 0.985 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: baseTransition,
  },
};

export const appExit: Variants = {
  exit: {
    opacity: 0,
    y: 12,
    scale: 0.99,
    transition: { duration: 0.22, ease: EASE_EMPHASIZED },
  },
};

/** Combined app-transition variants (enter + exit) for a single motion node. */
export const appTransition: Variants = {
  ...appEnter,
  ...appExit,
};

/** Bottom-sheet: rises from below the viewport, settles with emphasized ease. */
export const sheet: Variants = {
  initial: { y: "100%" },
  animate: { y: 0, transition: baseTransition },
  exit: { y: "100%", transition: { duration: 0.24, ease: EASE_EMPHASIZED } },
};

/** Scrim/backdrop behind a sheet or modal. */
export const scrim: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.24, ease: EASE_EMPHASIZED } },
  exit: { opacity: 0, transition: { duration: 0.2, ease: EASE_EMPHASIZED } },
};

/** Subtle fade + rise for list rows, cards, empty states. */
export const fadeUp: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, ease: EASE_EMPHASIZED },
  },
};

/**
 * Stagger container for entrance animations (e.g. launcher grid). Children
 * should use `fadeUp`. Stagger collapses to 0 under reduced motion.
 */
export function staggerContainer(stagger = 0.04): Variants {
  const reduce = prefersReducedMotion();
  return {
    initial: {},
    animate: {
      transition: {
        staggerChildren: reduce ? 0 : stagger,
        delayChildren: reduce ? 0 : stagger,
      },
    },
  };
}

/** Press feedback for tappable cards/buttons (scale-on-tap). */
export const tapScale = {
  whileTap: { scale: 0.97 },
  transition: { duration: 0.12, ease: EASE_EMPHASIZED },
} as const;
