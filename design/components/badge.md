---
title: Badge
description: Tags, pills, and status indicators.
status: stable
tokens:
  - colors.primary
  - colors.accent
  - colors.secondary
  - colors.muted
  - rounded.full
  - typography.caption
---

# Badge

Small labels for categorization, status, and metadata.

## Anatomy

```
┌───────────────┐
│ [dot] Label   │
└───────────────┘
```

## Variants

| Variant   | Background              | Text              | Use For                     |
|-----------|-------------------------|-------------------|-----------------------------|
| Default   | Teal 100                | Teal 800          | Categories, tags            |
| Accent    | Green 200               | Ink               | Highlights, new, featured   |
| Muted     | `--muted`               | `--muted-fg`      | Metadata, secondary info    |
| Success   | Green 200               | Teal 800          | Active, online, completed   |
| Warning   | Gold 200                | Gold 800          | Pending, attention needed   |
| Danger    | Coral 100               | Coral 700         | Error, offline, critical    |
| Outline   | transparent             | `--foreground`    | Subtle categorization       |

## Properties

| Property | Value                    |
|----------|--------------------------|
| Radius   | `full` (9999px — pill)   |
| Font     | Caption (0.75rem, 500)   |
| Padding  | 2px vertical, 8px horiz  |
| Height   | 22px                     |

## Status Dot

A small colored circle prepended to the label for status badges:

```
● Online    ● Offline    ● Busy
```

Dot size: 6px, same color as text.

## Mono Label

For technical/uppercase indicators (version numbers, categories in headers):

```tsx
<span className="font-mono text-xs font-medium tracking-widest uppercase
                 text-primary">
  v2.1.0
</span>
```

## Do's and Don'ts

**Do:**
- Keep badge text to 1-2 words
- Use consistent badge variants for the same type of information
- Group badges horizontally with `sm` (8px) gap

**Don't:**
- Use badges for long text or sentences
- Mix badge sizes in the same row
- Use more than 3-4 badges on a single card
