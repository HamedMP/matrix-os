---
name: matrix-landing-design
description: Design landing pages, marketing surfaces, and public-facing pages for Matrix OS. Covers hero sections, feature blocks, pricing, CTAs, and the brand's atmospheric style.
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
metadata:
  agent:
    tags: [Matrix OS, landing page, marketing, hero, brand, website]
    related_skills: [matrix-design-system]
---

# Matrix OS Landing Page Design

## When to Use

Use this when building or redesigning landing pages, marketing sites, public-facing pages, or any surface that communicates what Matrix OS is to the outside world. For in-app UI, use `matrix-app-ui-patterns` instead.

## Tone

Landing pages are where the brand speaks loudest. The feeling should be:
- **Warm, not corporate** — this is a personal computer, not enterprise software
- **Calm, not hype** — confidence without exclamation marks
- **Crafted, not templated** — every section earns its place

## Hero Section

The hero is the first thing anyone sees. It sets the entire mood.

### Structure

```
[Section label]              ← tiny uppercase, ember color, with line prefix
                             
Headline in                  ← Orbitron, 4-7rem, weight 700-800
Orbitron                       letter-spacing: -0.03 to -0.04em
                               emphasis word gets ember underline
                             
One sentence that expands    ← Inter, 1-1.125rem, weight 300, --muted-fg
on the headline.               max-width: 520px, line-height: 1.7
                             
[Primary CTA]  [Ghost CTA]  ← pill buttons, 16px vertical padding
```

### Hero Atmosphere

The hero must not be a flat white page. Layer these:

1. **Topographic SVG pattern** — fixed position, 3-5% opacity, tiled
2. **Grain overlay** — SVG noise texture, fixed, 2-3% opacity
3. **Radial light blurs** — large (500-700px) radial gradients of Cream (50% opacity) and Ember (5-8% opacity) placed behind/around content
4. **Staggered entrance animation** — each element fades up with 100ms delay between them. 0.8s duration, `cubic-bezier(0.25, 0.46, 0.45, 0.94)`.

```css
.hero::before {
  content: '';
  position: absolute;
  top: -20%;
  right: -10%;
  width: 700px;
  height: 700px;
  background: radial-gradient(ellipse, rgba(224,225,202,0.5) 0%, transparent 70%);
}
```

### Hero Typography

- Headlines: Orbitron 700-800, `clamp(3rem, 8vw, 7rem)`, line-height 0.95
- The **emphasis word** gets an Ember underline accent (pseudo-element, 0.12em height, 60% opacity, 4px radius)
- Subheading: Inter 300, 1.125rem, `--muted-fg`, max-width 520px

## Section Labels

Every major section has a label above the title:

```css
.section-label {
  font-family: 'Inter';
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--muted-fg);
  margin-bottom: 16px;
}
```

Often prefixed with a section number: `01 — Palette`, `02 — Typography`.

Optionally use `--accent` (Ember) color for the label with a leading line:

```css
.section-label::before {
  content: '';
  width: 32px;
  height: 1px;
  background: var(--accent);
  display: inline-block;
  vertical-align: middle;
  margin-right: 12px;
}
```

## Section Titles

```css
.section-title {
  font-family: 'Orbitron';
  font-size: clamp(1.75rem, 4vw, 3rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
  max-width: 700px;
}
```

Section descriptions: Inter 300-400, 1rem, `--muted-fg`, max-width 500px, line-height 1.7.

## Dark Sections

Sections with `--deep` background for contrast and emphasis:

```css
.dark-section {
  background: #32352E;
  color: #FAFAF5;
  border-radius: 32px;
  margin: 0 24px;
  overflow: hidden;
  padding: 80px 48px;
}
```

- Round the container (32px radius) and inset it from page edges (24px margin)
- Labels become `rgba(250,250,245,0.4)`
- Descriptions become `rgba(250,250,245,0.5)`
- Buttons invert: use `--bg` color on `--deep` backgrounds

## Feature Blocks

Show capabilities with icon + title + description:

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ ◎                │  │ ◎                │  │ ◎                │
│ Feature Title    │  │ Feature Title    │  │ Feature Title    │
│ One-line desc    │  │ One-line desc    │  │ One-line desc    │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

- 3-column grid on desktop, 1-column on mobile
- Icon: 36-40px, `--forest` color, Lucide line icons
- Title: Inter 1rem, weight 600
- Description: Inter 0.875rem, `--muted-fg`, 2 lines max
- Card: `--card` background, 1px border, 24px radius, 32px padding

## App Window Showcase

Show Matrix OS in action with a floating window mockup:

```css
.app-window {
  background: var(--card);
  border-radius: 20px;
  border: 1px solid var(--border);
  box-shadow: 0 20px 60px rgba(50,53,46,0.1), 0 1px 3px rgba(50,53,46,0.05);
  overflow: hidden;
}
```

- Traffic lights: 11px circles, `#FF5F57` / `#FEBC2E` / `#28C840`, 7px gap
- Title bar: 14px vertical padding, centered title text (0.75rem, `--muted-fg`)
- Float animation: `translateY(-8px)` over 6s, ease-in-out, infinite — gives the window a living quality

## Gradient Banner

For callout sections:

```css
background: linear-gradient(135deg, #32352E 0%, #434E3F 40%, #E0E1CA 100%);
border-radius: 24px;
padding: 48px 32px;
color: white;
```

## Call-to-Action Sections

Final CTA before footer:

- Centered layout
- Orbitron headline, 2-3rem
- One sentence description
- Two buttons: Ember CTA (primary) + Ghost (secondary)
- Background: Cream gradient or topographic pattern

## Navigation Bar

```css
.nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  padding: 16px 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(250,250,245,0.85);
  backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(214,211,200,0.5);
}
```

- Logo: Orbitron, 0.8rem, weight 700, letter-spacing 0.1em, Forest color
- Nav links: Inter, 0.8rem, weight 400, Forest color, underline on hover
- CTA button: small Ember pill

## Footer

Minimal:

```css
.footer {
  padding: 80px 48px 48px;
  text-align: center;
}
.footer-logo {
  font-family: 'Orbitron';
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.15em;
  color: var(--forest);
}
.footer-tagline {
  font-size: 0.75rem;
  color: var(--muted-fg);
  margin-top: 8px;
}
```

## Section Spacing

- Section padding: 100-120px vertical, 48px horizontal
- Section gap between title and content: 48px
- On mobile: reduce vertical padding to 64-80px, horizontal to 24px

## Responsive

| Breakpoint | Changes                                               |
|------------|-------------------------------------------------------|
| < 900px    | 2-column grids → 1 column, reduce section padding     |
| < 640px    | Hero headline scales down via clamp, stack all grids   |
| < 480px    | Full-bleed sections (remove margin/radius on dark sections) |

## Photography & Imagery

From the brand sheet: use warm, natural imagery. Landscapes, organic textures, warm light. Photography should feel editorial, not stock.

- Overlay images with `mix-blend-mode: multiply` on Cream background for a warm tint
- Round image corners (16-20px radius)
- Never use harsh drop shadows on images — integrate with `border: 1px solid var(--border)`

## Do

- Layer atmosphere: pattern + grain + radial blurs
- Use Orbitron dramatically at hero scale
- Create sections with distinct personalities (dark section, cream section, white section)
- Stagger entrance animations
- Show the product (floating app windows, UI mockups)
- Use asymmetric layouts — not everything centered

## Don't

- Use generic stock photography
- Create a wall of text without visual anchors
- Use more than one Ember CTA per viewport
- Make the page feel like a template (centered everything, equal spacing, predictable rhythm)
- Use carousels or sliders
- Auto-play videos
