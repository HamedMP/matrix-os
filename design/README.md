# Matrix OS Design System

This directory contains the full design system specification for Matrix OS.

## Structure

```
DESIGN.md                    ← Source of truth (YAML tokens + design rationale)
design/
├── README.md                ← This file
├── foundations/
│   ├── colors.md            ← Color palette, usage rules, accessibility
│   ├── typography.md        ← Font stack, type scale, usage
│   ├── spacing.md           ← Spacing scale, layout grid, principles
│   └── elevation.md         ← Shadows, glass-morphism, z-index
├── components/
│   ├── button.md            ← Button variants, states, anatomy
│   ├── card.md              ← Card types, glass variant, layout
│   ├── input.md             ← Text inputs, textareas, selects
│   ├── badge.md             ← Tags, pills, status indicators
│   ├── dialog.md            ← Modals, sheets, drawers
│   ├── navigation.md        ← Dock, tabs, breadcrumbs
│   └── app-chrome.md        ← Window chrome, title bar, traffic lights
```

## How to Use

### For AI-assisted app generation

Include `DESIGN.md` in the AI context. It contains all tokens as YAML
frontmatter and all design rationale as prose — optimized to fit in 2-5K
tokens.

### For frontend development

The tokens in `DESIGN.md` map directly to CSS custom properties in
`shell/src/app/globals.css`. When updating the design system, update both
files.

### For app developers

Apps built on Matrix OS should read the component specs in `design/components/`
to understand available patterns. The OS injects theme CSS variables into app
iframes via the bridge.

## Design Principles

1. **Warm, not cold** — natural materials, forest/sand/ember palette
2. **Calm, not busy** — generous whitespace, restrained animation
3. **Rounded, not sharp** — soft corners everywhere, pill buttons
4. **Light, not dark** — warm off-white backgrounds, white card surfaces
5. **Purposeful, not decorative** — every element earns its place
