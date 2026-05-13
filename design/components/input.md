---
title: Input
description: Text inputs, textareas, and select fields.
status: stable
tokens:
  - colors.card
  - colors.input
  - colors.foreground
  - colors.muted-foreground
  - colors.ring
  - rounded.lg
---

# Input

Form inputs for collecting user data.

## Anatomy

```
  Label (optional)
┌──────────────────────────────┐
│ [icon]  Placeholder text     │
└──────────────────────────────┘
  Helper text or error (optional)
```

## Variants

| Variant   | Background | Border          | Use For                    |
|-----------|------------|-----------------|----------------------------|
| Default   | `--card`   | 1px `--input`   | Standard form fields       |
| Ghost     | transparent| none            | Inline editing, search bars|

## Properties

| Property    | Value                     |
|-------------|---------------------------|
| Height      | 40px (md), 32px (sm)      |
| Radius      | `lg` (14px)               |
| Padding     | 8px vertical, 16px horiz  |
| Font        | Inter, body-small (0.875rem) |
| Placeholder | `--muted-foreground`      |
| Border      | 1px solid `--input`       |

## States

| State    | Change                                          |
|----------|-------------------------------------------------|
| Default  | 1px border `--input`                             |
| Hover    | Border darkens slightly                          |
| Focus    | 2px ring in `--ring`, border becomes `--ring`    |
| Error    | Border and ring become `--destructive`           |
| Disabled | 50% opacity, `--muted` background                |

## Input Bar Pattern (Shell)

The main command input uses the glass variant — centered at viewport bottom,
full-width within constraints:

```tsx
<div className="flex items-center gap-2 rounded-xl border bg-white/90
                backdrop-blur-md px-4 py-2 shadow-lg">
  <Input className="border-0 bg-transparent shadow-none
                    focus-visible:ring-0" />
  <Button size="icon" variant="ghost">
    <Send />
  </Button>
</div>
```

## Textarea

Same styling as Input but with:
- Minimum height: 80px
- Resize: vertical only
- Auto-grow: expand to fit content up to a max height

## Select

Trigger styled identically to Input. Dropdown uses the popover pattern
(glass-morphism, `lg` shadow, `lg` radius).

## Do's and Don'ts

**Do:**
- Always include a visible label (or `aria-label` if label is hidden)
- Show validation errors inline below the field
- Use placeholder text for format hints, not as labels

**Don't:**
- Use different border radius on inputs vs buttons in the same form
- Show errors before the user has interacted with the field
- Rely on color alone to communicate error state (add an icon or text)
