---
version: "0.1.0"
name: "Matrix OS"
tagline: "Technology that understands you."
description: >
  Matrix OS is your personal cloud computer — a calm, intelligent space that
  keeps you in flow, wherever you are. The visual language is warm, organic,
  and approachable. It draws from natural materials (forest, sand, terracotta)
  rather than neon/tech aesthetics.

pillars:
  - Warm
  - Personal
  - Seamless
  - Mindful
  - Trusted
  - Calm

colors:
  forest: "#434E3F"
  cream: "#E0E1CA"
  ember: "#D06F25"
  deep: "#32352E"

  background: "#FAFAF5"
  foreground: "#32352E"
  card: "#FFFFFF"
  card-foreground: "#32352E"
  primary: "#434E3F"
  primary-foreground: "#FAFAF5"
  secondary: "#E0E1CA"
  secondary-foreground: "#32352E"
  accent: "#D06F25"
  accent-foreground: "#FFFFFF"
  muted: "#F0EDE4"
  muted-foreground: "#7A7768"
  border: "#D6D3C8"
  input: "#D6D3C8"
  ring: "#434E3F"
  destructive: "#C4342D"
  success: "#3A7D44"
  warning: "#D49B2A"

  sand-light: "#F7F1E7"
  sand-mid: "#F3EAE0"
  sand-warm: "#D6AB8B"

  gradient-deep: "#32352E"
  gradient-mid: "#434E3F"
  gradient-light: "#E0E1CA"
  gradient-accent: "#D06F25"

typography:
  display:
    fontFamily: "Orbitron"
    fontSize: "3rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  h1:
    fontFamily: "Orbitron"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  h2:
    fontFamily: "Orbitron"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.2
  h3:
    fontFamily: "Inter"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
  h4:
    fontFamily: "Inter"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Inter"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  body-small:
    fontFamily: "Inter"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Inter"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: "JetBrains Mono"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.05em"
    textTransform: "uppercase"

spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
  3xl: "64px"
  4xl: "96px"

rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "20px"
  2xl: "28px"
  full: "9999px"

shadows:
  xs: "0 1px 2px rgba(50, 53, 46, 0.04)"
  sm: "0 2px 4px rgba(50, 53, 46, 0.06)"
  md: "0 4px 12px rgba(50, 53, 46, 0.08)"
  lg: "0 8px 24px rgba(50, 53, 46, 0.10)"
  xl: "0 16px 48px rgba(50, 53, 46, 0.12)"

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.xl}"
    fontSize: "{typography.body-small.fontSize}"
    fontWeight: 500
    paddingX: "{spacing.lg}"
    paddingY: "{spacing.sm}"
  button-primary-hover:
    backgroundColor: "{colors.deep}"
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    rounded: "{rounded.xl}"
  button-accent-hover:
    backgroundColor: "#B85E1F"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    borderColor: "{colors.border}"
    rounded: "{rounded.xl}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
  card:
    backgroundColor: "{colors.card}"
    borderColor: "{colors.border}"
    rounded: "{rounded.xl}"
    shadow: "{shadows.sm}"
    padding: "{spacing.lg}"
  card-hover:
    shadow: "{shadows.md}"
  input:
    backgroundColor: "{colors.card}"
    borderColor: "{colors.input}"
    rounded: "{rounded.lg}"
    fontSize: "{typography.body.fontSize}"
    paddingX: "{spacing.md}"
    paddingY: "{spacing.sm}"
  badge:
    rounded: "{rounded.full}"
    fontSize: "{typography.caption.fontSize}"
    fontWeight: 500
    paddingX: "{spacing.sm}"
    paddingY: "2px"
---

## Overview

Matrix OS is a personal cloud computer. The design language communicates warmth,
trust, and calm intelligence. Every surface should feel like a well-made
physical object — natural materials, soft edges, generous whitespace, deliberate
restraint.

The palette is drawn from forest, sand, and ember. Green conveys stability and
trust. Cream provides warmth and breathing room. Orange is the spark — used
sparingly for primary calls to action and moments that need attention.

This is not a developer tool aesthetic. This is a living space.

## Colors

### Brand Colors

| Name     | Hex       | Role                                        |
|----------|-----------|---------------------------------------------|
| Forest   | `#434E3F` | Primary brand, buttons, text emphasis        |
| Cream    | `#E0E1CA` | Secondary surfaces, backgrounds, warmth      |
| Ember    | `#D06F25` | Accent, CTAs, highlights, active states      |
| Deep     | `#32352E` | Primary text, darkest tone, depth            |

### Usage Rules

- **Forest** is the workhorse — headers, primary buttons, icons, nav active states
- **Cream** is the resting surface — card backgrounds, secondary fills, hover states
- **Ember** is reserved for action — one primary CTA per view, notification badges,
  active toggles. Using it everywhere dilutes its power.
- **Deep** is for text and depth — body copy, title bars, shadows, overlays
- **White** (`#FFFFFF`) for card surfaces and elevated elements
- **Background** (`#FAFAF5`) is a warm off-white, never pure white

### Semantic Colors

| Token        | Hex       | Usage                          |
|--------------|-----------|--------------------------------|
| Destructive  | `#C4342D` | Errors, delete, danger         |
| Success      | `#3A7D44` | Positive states, confirmations |
| Warning      | `#D49B2A` | Warnings, caution states       |

All semantic colors are warm-tinted to sit comfortably in the palette. Avoid
pure red (#ff0000) or pure green (#00ff00).

### Contrast Notes

- Deep (#32352E) on Background (#FAFAF5): **13.2:1** — exceeds AAA
- Deep (#32352E) on Cream (#E0E1CA): **7.8:1** — exceeds AAA
- Forest (#434E3F) on White (#FFFFFF): **8.1:1** — exceeds AAA
- Ember (#D06F25) on White (#FFFFFF): **3.6:1** — meets AA for large text only;
  pair with Deep text on ember backgrounds for body copy

## Typography

### Font Stack

| Role      | Font            | Usage                                    |
|-----------|-----------------|------------------------------------------|
| Display   | Orbitron        | Logo, hero headings, marketing surfaces  |
| UI / Body | Inter           | All interface text, body, labels          |
| Code      | JetBrains Mono  | Terminal, code blocks, technical data     |

Orbitron is the brand voice — geometric, futuristic, distinctive. Use it for
headings that identify Matrix OS (hero sections, page titles, onboarding).
Do NOT use Orbitron for body text, labels, or navigation — it is not designed
for readability at small sizes.

Inter handles everything else. It is neutral, highly legible, and has excellent
support for all weights and sizes.

### Type Scale

| Level       | Font     | Size   | Weight | Line Height | Use For                     |
|-------------|----------|--------|--------|-------------|-----------------------------|
| Display     | Orbitron | 3rem   | 700    | 1.1         | Hero headlines, landing page |
| H1          | Orbitron | 2.25rem| 600    | 1.15        | Page titles                  |
| H2          | Orbitron | 1.75rem| 600    | 1.2         | Section headings             |
| H3          | Inter    | 1.25rem| 600    | 1.3         | Subtitles, subsections       |
| H4          | Inter    | 1.125rem| 600   | 1.4         | Card titles, group labels    |
| Body        | Inter    | 1rem   | 400    | 1.6         | Paragraphs, descriptions     |
| Body Small  | Inter    | 0.875rem| 400   | 1.5         | Secondary text, metadata     |
| Caption     | Inter    | 0.75rem| 400    | 1.4         | Timestamps, footnotes        |
| Label       | Inter    | 0.75rem| 500    | 1.4         | Uppercase tags, categories   |
| Mono        | JetBrains| 0.875rem| 400   | 1.5         | Code, terminal, data         |

## Layout

### Spacing Scale

Built on a 4px base grid. Every spacing value is a multiple of 4.

| Token | Value | Use For                          |
|-------|-------|----------------------------------|
| xs    | 4px   | Tight gaps, icon padding         |
| sm    | 8px   | Inline spacing, small gaps       |
| md    | 16px  | Default padding, component gaps  |
| lg    | 24px  | Card padding, section spacing    |
| xl    | 32px  | Large gaps between groups        |
| 2xl   | 48px  | Section breaks                   |
| 3xl   | 64px  | Page section padding             |
| 4xl   | 96px  | Hero/landing section padding     |

### Principles

- Generous whitespace. When in doubt, add more space, not less.
- Content width: `max-w-6xl` (1152px) for full layouts, `max-w-3xl` for reading.
- Mobile-first. Every layout must work at 320px width.
- The shell is full viewport (`100vh × 100vw`, `overflow: hidden`).

## Elevation & Depth

### Shadows

| Level | Value                                  | Use For                    |
|-------|----------------------------------------|----------------------------|
| xs    | `0 1px 2px rgba(50,53,46,0.04)`       | Inputs, subtle lift        |
| sm    | `0 2px 4px rgba(50,53,46,0.06)`       | Cards at rest              |
| md    | `0 4px 12px rgba(50,53,46,0.08)`      | Cards on hover, dropdowns  |
| lg    | `0 8px 24px rgba(50,53,46,0.10)`      | Floating panels, modals    |
| xl    | `0 16px 48px rgba(50,53,46,0.12)`     | Windows, dialogs           |

Shadow color is always derived from Deep (`#32352E`), never pure black.

### Glass-morphism

Floating/transient elements use frosted glass:

```css
background: rgba(255, 255, 255, 0.80);
backdrop-filter: blur(12px);
border: 1px solid var(--border);
```

Heavier variant for input bars:
```css
background: rgba(255, 255, 255, 0.90);
backdrop-filter: blur(16px);
```

## Shapes

### Border Radius

Every interactive element has rounded corners. No sharp edges.

| Token | Value  | Use For                         |
|-------|--------|---------------------------------|
| sm    | 6px    | Small chips, tags, inline code  |
| md    | 10px   | Inputs, small buttons           |
| lg    | 14px   | Cards, panels, dialogs          |
| xl    | 20px   | Feature cards, windows          |
| 2xl   | 28px   | Hero cards, large containers    |
| full  | 9999px | Pills, badges, avatars, FABs    |

Default component radius is `xl` (20px). When nesting rounded elements,
inner elements should use a smaller radius than their container.

## Components

### Buttons

Buttons are pill-shaped (rounded-xl to rounded-full) with clear hierarchy:

| Variant   | Background   | Text          | Border | Use For                     |
|-----------|-------------|---------------|--------|-----------------------------|
| Primary   | Forest      | White         | None   | Main action per view        |
| Accent    | Ember       | White         | None   | CTAs, sign up, "Get started"|
| Secondary | Transparent | Deep          | Border | Secondary actions           |
| Ghost     | Transparent | Deep          | None   | Tertiary, toolbar actions   |

- One accent button per view maximum
- Primary for the most important action in a section
- Hover state: darken background slightly, lift shadow
- Active state: scale down 1-2%
- Disabled: 40% opacity, no pointer events

### Cards

Cards are the primary content container.

- Background: white (`#FFFFFF`)
- Border: 1px solid `var(--border)`
- Radius: `xl` (20px)
- Shadow: `sm` at rest, `md` on hover
- Padding: `lg` (24px)

Glass variant for floating/overlay cards:
```css
background: rgba(255, 255, 255, 0.80);
backdrop-filter: blur(12px);
```

### Inputs

- Background: white
- Border: 1px solid `var(--input)`
- Radius: `lg` (14px)
- Focus: 2px ring in Forest color
- Padding: `sm` vertical, `md` horizontal
- Placeholder text: `var(--muted-foreground)`

### Icons

- Style: line/outline, 1.5px stroke weight
- Library: Lucide
- Size: 16px (inline), 20px (buttons), 24px (navigation)
- Color: inherits text color

### Pattern System

A topographic/organic line pattern is used for decorative backgrounds:
- Stroke color: `rgba(67, 78, 63, 0.06)` (Forest at 6% opacity)
- Used on: landing page hero, empty states, onboarding
- Never competes with content — purely decorative, behind everything

## Do's and Don'ts

### Do

- Use generous whitespace — let content breathe
- Use Forest for structure, Ember for action, Cream for warmth
- Keep corners rounded (`xl` for cards, `full` for pills)
- Use Inter for all UI text including subtitles, card titles, and descriptions
- Use Orbitron only for H1/H2 display headings and large stat numbers
- Match shadow color to the palette (Deep-tinted, never black)
- Use backdrop blur on floating elements
- Animate with purpose: 150-300ms, ease-out for enter, ease-in for exit
- Design for the smallest viewport first (320px)
- Maintain warm off-white backgrounds — never pure white pages

### Don't

- Use sharp corners (`rounded-none`) anywhere
- Use Orbitron for subtitles (H3+), body text, card titles, or small labels
- Use Ember on everything — it's an accent, not a primary
- Use pure black text or shadows (`#000000`)
- Use neon, high-saturation, or cool-toned accent colors
- Add heavy gradients — keep it flat with subtle depth from blur/shadow
- Put more than one Ember/accent CTA in a single view
- Mix font families in the same element
- Use dark backgrounds in the default theme (this is a light-mode OS)
- Ignore `prefers-reduced-motion` — always provide reduced-motion fallbacks
