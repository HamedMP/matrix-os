---
title: Colors
description: Matrix OS color palette, semantic tokens, and usage guidelines.
status: stable
---

# Colors

## Brand Palette

Four colors define the Matrix OS identity.

| Name   | Hex       | RGB              | Role                                          |
|--------|-----------|------------------|-----------------------------------------------|
| Forest | `#434E3F` | `67, 78, 63`    | Primary brand, structural elements, authority  |
| Cream  | `#E0E1CA` | `224, 225, 202`  | Warmth, secondary surfaces, resting states     |
| Ember  | `#D06F25` | `208, 111, 37`   | Action, energy, calls to attention             |
| Deep   | `#32352E` | `50, 53, 46`     | Text, depth, grounding                         |

## UI Token Map

These CSS custom properties are the closed token set. All UI code must reference
tokens — never hardcode hex values.

### Surfaces

| Token                  | Value     | Usage                              |
|------------------------|-----------|-------------------------------------|
| `--background`         | `#FAFAF5` | Page/canvas background (warm white) |
| `--foreground`         | `#32352E` | Primary text                        |
| `--card`               | `#FFFFFF` | Card/panel surfaces                 |
| `--card-foreground`    | `#32352E` | Text on cards                       |
| `--popover`            | `#FFFFFF` | Popover/dropdown surfaces           |
| `--popover-foreground` | `#32352E` | Text on popovers                    |
| `--muted`              | `#F0EDE4` | Muted backgrounds, disabled fills   |
| `--muted-foreground`   | `#7A7768` | De-emphasized text                  |

### Interactive

| Token                     | Value     | Usage                         |
|---------------------------|-----------|-------------------------------|
| `--primary`               | `#434E3F` | Primary buttons, active nav   |
| `--primary-foreground`    | `#FAFAF5` | Text on primary               |
| `--secondary`             | `#E0E1CA` | Secondary buttons, fills      |
| `--secondary-foreground`  | `#32352E` | Text on secondary             |
| `--accent`                | `#D06F25` | CTA buttons, highlights       |
| `--accent-foreground`     | `#FFFFFF` | Text on accent                |

### Chrome

| Token       | Value     | Usage                           |
|-------------|-----------|----------------------------------|
| `--border`  | `#D6D3C8` | All borders (warm gray)          |
| `--input`   | `#D6D3C8` | Input borders                    |
| `--ring`    | `#434E3F` | Focus rings                      |

### Semantic

| Token           | Value     | Usage                         |
|-----------------|-----------|-------------------------------|
| `--destructive` | `#C4342D` | Errors, delete, danger        |
| `--success`     | `#3A7D44` | Positive, confirmation        |
| `--warning`     | `#D49B2A` | Warnings, caution             |

### Gradient (Background/Desktop)

| Token              | Value     |
|--------------------|-----------|
| `--gradient-deep`  | `#32352E` |
| `--gradient-mid`   | `#434E3F` |
| `--gradient-light` | `#E0E1CA` |
| `--gradient-accent`| `#D06F25` |

## Accessibility

All text/background combinations must meet WCAG AA (4.5:1 for body, 3:1 for
large text).

| Combination                        | Ratio    | Passes        |
|------------------------------------|----------|---------------|
| Deep on Background (#32352E / #FAFAF5) | 13.2:1 | AAA           |
| Deep on Cream (#32352E / #E0E1CA)      | 7.8:1  | AAA           |
| Forest on White (#434E3F / #FFFFFF)    | 8.1:1  | AAA           |
| Forest on Background (#434E3F / #FAFAF5)| 7.6:1 | AAA           |
| Ember on White (#D06F25 / #FFFFFF)     | 3.6:1  | AA large only |
| White on Ember (#FFFFFF / #D06F25)     | 3.6:1  | AA large only |
| White on Forest (#FFFFFF / #434E3F)    | 8.1:1  | AAA           |

**Rule**: Never use Ember as a background for small body text. Pair Ember
backgrounds with white text at 18px+ or bold 14px+. For smaller text on
Ember, use Deep instead.

## Usage Rules

1. **One Ember accent per view.** Ember is the loudest color — using it on
   multiple elements in the same view creates visual noise.
2. **Forest is structural.** It carries authority. Use for headers, primary
   buttons, navigation active states, and icons.
3. **Cream is warmth.** It fills space without demanding attention. Secondary
   surfaces, hover states, sidebar backgrounds.
4. **Deep is text.** Almost all body text uses Deep. Reserve Forest for headings
   and interactive text (links, button labels).
5. **Never use pure black** (`#000000`). Deep (#32352E) is the darkest value
   in the system.
6. **Never use pure white backgrounds** for the page. Use Background (#FAFAF5).
   Cards and elevated surfaces may be white (#FFFFFF).
