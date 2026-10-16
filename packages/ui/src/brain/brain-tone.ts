import type { CSSProperties } from "react";

/**
 * The Company Brain's colors: DESIGN.md's semantic and control tokens, with the dark values of the Native Mobile
 * theme (the neutral ramp mirrored). BrainApp sets them on its root. Each is `light-dark(light, dark)`, and every
 * renderer sets `color-scheme` with its theme, so the classes below need no `dark:` variants.
 */
export const BRAIN_THEME = {
  "--brain-canvas": "light-dark(#FFFEFC, #0D0C0C)",
  "--brain-fill": "light-dark(#FAF9F7, #242323)",
  "--brain-text": "light-dark(#242323, #F3F2F2)",
  "--brain-text-secondary": "light-dark(#635F5F, #A8A4A4)",
  "--brain-text-tertiary": "light-dark(#8A8686, #827D7D)",
  "--brain-border": "light-dark(#F3F2F2, #413E3E)",
  "--brain-border-strong": "light-dark(#C8C6C6, #413E3E)",
  "--brain-primary": "light-dark(#171717, #FAFAFA)",
  "--brain-on-primary": "light-dark(#FAFAFA, #171717)",
  "--brain-outline": "light-dark(#FFFFFF, #0D0C0C)",
  "--brain-outline-border": "light-dark(#E5E5E5, #413E3E)",
  "--brain-secondary": "light-dark(#F5F5F5, #242323)",
  "--brain-on-secondary": "light-dark(#171717, #F3F2F2)",
  "--brain-on-control": "light-dark(#0A0A0A, #F3F2F2)",
  "--brain-chip": "light-dark(#F2F2F0, #242323)",
  "--brain-chip-selected": "light-dark(#0D0D0D, #FAFAFA)",
  "--brain-on-chip-selected": "light-dark(#FFFFFF, #0D0D0D)",
  "--brain-focus": "#F1C379",
  "--brain-success": "light-dark(#288A5B, #34B275)",
  "--brain-warning": "#E0AA52",
  "--brain-danger": "light-dark(#BA5236, #D06E53)",
  "--brain-info": "light-dark(#3B85BA, #5CA0D1)",
  "--brain-highlight": "light-dark(#FAEAD1, #4D3919)",
} as CSSProperties;

/** Color, shape and focus classes over BRAIN_THEME. Every class is a literal, so the Tailwind scan of this folder sees it. */
export const BRAIN_TONE = {
  border: "border-[var(--brain-border)]",
  hover: "hover:bg-[var(--brain-fill)]",
  selected: "aria-selected:bg-[var(--brain-fill)] aria-selected:font-semibold aria-selected:text-[var(--brain-text)]",
  /**
   * A gold ring set off from the control. `outline-none` also sets Tailwind's outline style variable to none, so the
   * ring sets the style back with `focus-visible:outline-solid`. Electron Desktop draws its own global focus ring.
   */
  focus:
    "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brain-focus)]",
  /** The window surface. */
  surface: "bg-[var(--brain-canvas)] text-[var(--brain-text)]",
  /** A card: the canvas with a hairline, 14 px corners, no shadow. Content nested in it uses `fill` or spacing. */
  card: "rounded-[14px] border border-[var(--brain-border)] bg-[var(--brain-canvas)]",
  /** A filled box with no line: empty states, notices, the brief summary, a confirm inside a list. */
  fill: "rounded-[14px] bg-[var(--brain-fill)]",
  /** A panel over the content (the confirms): no shadow, so the stronger line sets it off. */
  overlay: "rounded-[14px] border border-[var(--brain-border-strong)] bg-[var(--brain-canvas)] text-[var(--brain-text)]",
  text: "text-[var(--brain-text)]",
  secondary: "text-[var(--brain-text-secondary)]",
  /** Placeholders and times only: it is below AA for small text. */
  tertiary: "text-[var(--brain-text-tertiary)]",
  danger: "text-[var(--brain-danger)]",
  /** Status indicators; each sits beside words, never alone. */
  dotGood: "bg-[var(--brain-success)]",
  dotWarn: "bg-[var(--brain-warning)]",
  iconWarn: "text-[var(--brain-warning)]",
  mark: "bg-[var(--brain-highlight)]",
  /** A 44 px tall touch area around a smaller control, without moving anything. */
  hit: "relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2",
  motion: "transition-[background-color,border-color,color,opacity] duration-150 motion-reduce:transition-none",
} as const;

/** The product interface type scale: Geist with no letter spacing; Geist Mono for paths, keys and ids. */
export const BRAIN_TYPE = {
  family: "font-[family-name:var(--font-geist-sans,Geist),Geist,system-ui,sans-serif] tracking-normal",
  machine: "font-[family-name:var(--font-geist-mono,'Geist_Mono'),'Geist_Mono',ui-monospace,monospace]",
  subheading: "text-[18px] leading-[25px] font-semibold",
  body: "text-[16px] leading-[22px]",
  callout: "text-[15px] leading-[22px]",
  label: "text-[14px] leading-[20px]",
  caption: "text-[13px] leading-[18px]",
  footnote: "text-[12px] leading-[17px]",
  micro: "text-[11px] leading-[15px]",
} as const;
