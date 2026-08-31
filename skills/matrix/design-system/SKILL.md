---
name: matrix-design-system
description: Apply the current Matrix OS brand, theme contract, accessibility bar, and taste-adaptive visual direction to system surfaces and user-built apps.
license: MIT
metadata:
  version: 3.0.0
  author: Matrix OS
  platforms: [linux, macos]
  agent:
    tags: [Matrix OS, design, UI, brand, theme, typography, accessibility]
    related_skills: [matrix-app-builder, matrix-app-ui-patterns, find-animation-opportunities, animate]
---

# Matrix OS Design System

## When to Use

Use this for every Matrix OS visual surface and every app built inside Matrix. Pair it with `matrix-app-ui-patterns` for layout and with the relevant animation skills when motion is warranted.

The approved source is the 2026 Matrix brand guideline. System-owned surfaces follow it directly. User-built apps use it as an integration frame and fallback while adapting their identity to the user's taste.

## Brand Principle

**Technology that understands you.** Interfaces should feel clear, calm, capable, and personal.

- One clear next step.
- Structure before decoration.
- Real loading, empty, disabled, success, and error states.
- Platform-aware parity across Matrix surfaces.
- Accessible contrast, focus, type, and motion.
- Innovation grounded in the user's taste and the product's domain.

## Current Brand

| Role | Value | Typical use |
|---|---|---|
| Teal | `#0E3422` | Primary structure, key actions, dark brand field |
| Coral | `#D06E53` | Human warmth, selected accents, emphasis |
| Gold | `#F1C379` | Optimism, highlight, supporting accent |
| Green | `#BED77B` | Positive energy, success-adjacent illustration |
| Blue | `#C5D6E2` | Calm information, cool supporting field |
| Display | Bricolage Grotesque | Expressive headings and brand moments |
| Body/UI | Geist | Controls, body copy, navigation, dense product UI |
| Mono | Geist Mono | Code, terminal, identifiers, machine output |

Do not revive retired palette or typography rules. Do not turn the five brand colors into a requirement to use every color in every view.

## Theme Contract

Apps receive live shell tokens. Use `--matrix-*` directly or alias them to app-local semantic names. Literal values are fallbacks, never replacements for inherited theme behavior.

```css
:root {
  --app-bg: var(--matrix-bg, #F7F4EC);
  --app-fg: var(--matrix-fg, #0E3422);
  --app-card: var(--matrix-card, #FFFFFF);
  --app-primary: var(--matrix-primary, #0E3422);
  --app-primary-fg: var(--matrix-primary-fg, #FFFFFF);
  --app-accent: var(--matrix-accent, #D06E53);
  --app-accent-fg: var(--matrix-accent-fg, #FFFFFF);
  --app-border: var(--matrix-border, color-mix(in srgb, #0E3422 18%, transparent));
  --app-success: var(--matrix-success, #4F7D42);
  --app-warning: var(--matrix-warning, #A96E18);
  --app-danger: var(--matrix-destructive, #B83F38);
  --app-font-display: var(--matrix-font-display, "Bricolage Grotesque", sans-serif);
  --app-font-sans: var(--matrix-font-sans, Geist, system-ui, sans-serif);
  --app-font-mono: var(--matrix-font-mono, "Geist Mono", monospace);
}
```

System controls, focus rings, status semantics, and app chrome stay on Matrix tokens. Explicit app branding may introduce named app tokens without breaking those contracts.

## Taste-Adaptive Direction

Before visual implementation, create a concise **taste brief**:

1. Mood and personality.
2. Information density.
3. Typography character.
4. Color behavior.
5. Motion character.
6. One signature detail.

Build the brief from the user's stated taste, references, existing project, domain, and prior choices. Ask one short question only if it would materially change the outcome and no useful clues exist. Otherwise infer and proceed.

The Matrix brand is the default and system frame, not a uniform marketing skin. A finance tool, music studio, children's game, and research notebook should not share the same compulsory gradients, glass cards, capsule controls, or animation wave.

## Typography

- Use Bricolage Grotesque selectively for display character, not dense data or every heading.
- Use Geist for product UI and readable prose.
- Use Geist Mono for code and machine-readable material.
- In sandboxed apps, inherit `--matrix-font-*`; do not load remote font stylesheets.
- Keep type scales proportional to the actual window. Product tools should not borrow oversized landing-page typography.
- Hierarchy comes from size, weight, spacing, and placement before decorative effects.

## Shape, Surface, and Color

Choose radii, borders, elevation, and surface treatment from the taste brief and task.

- Keep nested radii systematic.
- Use shadows to explain elevation, not as decoration everywhere.
- Use gradients, glass, texture, or flat fields only when they support the chosen direction.
- Keep contrast and status colors semantically reliable.
- Avoid pure novelty palettes for system controls.
- Avoid generic AI styling: violet-on-white gradients, arbitrary glowing cards, excessive pills, and decorative whitespace without hierarchy.

## Icons

Use accessible inline SVGs or bundled local assets. Do not load remote icon scripts or use text glyphs as control icons. Decorative icons should be hidden from assistive technology; icon-only controls need an accessible label.

Launcher icon direction comes from `system/desktop.json` when present. The fallback is a single legible object or symbol on a warm off-white or pale pastel background with controlled depth. The Matrix shell owns the final corner radius, so do not bake a second visible frame into the artwork.

## Motion

Motion is optional. Use it only to clarify causality, continuity, hierarchy, spatial relationship, or feedback.

- Explicitly load `find-animation-opportunities` before adding broad motion.
- Use `animate` for direction and either `css-animations` or `motion-react` for implementation.
- Every shipped animation must apply `animation-accessibility` and `animation-performance`.
- Respect `prefers-reduced-motion` with a deliberate alternate state.
- Prefer transform and opacity when they express the intended change.
- Keep static what gains no clarity from movement.
- Verify on the actual target size and device. No horizontal overflow.

## Component and State Bar

Reuse shadcn-style or existing repository primitives when available. Do not introduce a second component system for a control already solved by the project.

Every interactive surface includes:

- visible hover, focus, active, and disabled states;
- loading behavior that preserves layout;
- helpful empty and error states;
- keyboard reachability and sensible focus order;
- 44px-class touch targets where appropriate;
- responsive behavior down to the supported Matrix window size.

## Verification

Before reporting visual work complete:

- compare the result against the taste brief;
- verify Matrix token inheritance and live theme changes;
- check light and dark themes when supported;
- check narrow and resized windows with no horizontal overflow;
- test keyboard and focus behavior;
- test reduced motion;
- inspect real loading, empty, error, disabled, and populated states;
- confirm the result has a clear focal action and one intentional signature detail.
