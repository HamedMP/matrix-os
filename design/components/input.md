---
title: Input
description: Text inputs, textareas, and select fields.
status: stable
tokens:
  - semanticColors.surface
  - semanticColors.border
  - semanticColors.foreground
  - semanticColors.mutedForeground
  - semanticColors.focus
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
| Default   | `semanticColors.surface` | 1px `semanticColors.border` | Standard form fields |
| Ghost     | transparent| none            | Inline editing, search bars|

## Properties

| Property    | Value                     |
|-------------|---------------------------|
| Height      | 40px (md), 32px (sm)      |
| Radius      | 12px                       |
| Padding     | 8px vertical, 16px horiz  |
| Font        | Geist, body-small (0.875rem) |
| Placeholder | `semanticColors.mutedForeground` |
| Border      | 1px solid `semanticColors.border` |

## States

| State    | Change                                          |
|----------|-------------------------------------------------|
| Default  | 1px border `semanticColors.border`                |
| Hover    | Border darkens slightly                          |
| Focus    | 2px Gold 300 ring; border becomes Gold 500       |
| Error    | Border and ring become `semanticColors.danger`    |
| Disabled | 50% opacity, `semanticColors.muted` background    |

## Input Bar Pattern (Shell)

The main command input uses the glass variant — centered at viewport bottom,
full-width within constraints:

```tsx
<div className="flex items-center gap-2 rounded-xl border bg-[rgba(252,252,248,0.90)]
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
