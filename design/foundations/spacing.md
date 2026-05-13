---
title: Spacing & Layout
description: Matrix OS spacing scale, layout grid, and whitespace principles.
status: stable
---

# Spacing & Layout

## Spacing Scale

Built on a 4px base unit. Every spacing value is a multiple of 4.

| Token | Value | Tailwind  | Use For                                |
|-------|-------|-----------|----------------------------------------|
| xs    | 4px   | `p-1`    | Tight gaps — icon-to-text, inline tags |
| sm    | 8px   | `p-2`    | Small gaps — button padding, list gaps |
| md    | 16px  | `p-4`    | Default — component padding, form gaps |
| lg    | 24px  | `p-6`    | Card padding, group spacing            |
| xl    | 32px  | `p-8`    | Section spacing, large gaps            |
| 2xl   | 48px  | `p-12`   | Section breaks, major separations      |
| 3xl   | 64px  | `p-16`   | Page section padding (vertical)        |
| 4xl   | 96px  | `p-24`   | Hero/landing section padding           |

## Layout Widths

| Token      | Value  | Use For                              |
|------------|--------|--------------------------------------|
| content-sm | 640px  | Narrow content (onboarding, forms)   |
| content-md | 768px  | Reading content (docs, descriptions) |
| content-lg | 1024px | Standard layouts (dashboards)        |
| content-xl | 1152px | Full-width sections (landing page)   |

## Grid

Use a 12-column grid at `content-xl` width with `md` (16px) column gaps.

On mobile (< 768px), collapse to a single column with `md` (16px) horizontal
padding.

## Principles

### Whitespace is a Feature

Matrix OS is calm. Whitespace communicates that the user has room to think.

- When a layout feels cramped, add space before adding borders or dividers
- Section spacing should be at least `2xl` (48px)
- Card padding should be at least `lg` (24px)
- Never go below `sm` (8px) between interactive elements (touch target safety)

### Consistent Gaps

Use the same gap value for all items in a group. If cards in a grid use
`md` (16px) gap, all cards in that grid use `md`. Don't mix gap values
within a single layout group.

### Touch Targets

All interactive elements must be at least 44×44px in touch area, even if
visually smaller. Use padding or invisible hit areas to achieve this.
