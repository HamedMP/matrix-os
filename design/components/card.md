---
title: Card
description: Cards are the primary content container in Matrix OS.
status: stable
tokens:
  - semanticColors.surface
  - semanticColors.foreground
  - semanticColors.border
  - rounded.xl
  - shadows.sm
  - shadows.md
  - spacing.lg
---

# Card

Cards group related content and actions into a single surface.

## Anatomy

```
┌──────────────────────────────────┐
│  Card Header                     │
│  ┌──────────────────────────────┐│
│  │ Title              [Action]  ││
│  │ Description                  ││
│  └──────────────────────────────┘│
│                                  │
│  Card Content                    │
│  ┌──────────────────────────────┐│
│  │ ...                          ││
│  └──────────────────────────────┘│
│                                  │
│  Card Footer                     │
│  ┌──────────────────────────────┐│
│  │ [Secondary]     [Primary]    ││
│  └──────────────────────────────┘│
└──────────────────────────────────┘
```

## Variants

| Variant   | Background                    | Border | Shadow | Use For                      |
|-----------|-------------------------------|--------|--------|------------------------------|
| Default   | Paper `#FCFCF8`               | 1px    | `sm`   | Standard content containers  |
| Muted     | Green 50 or Blue 50           | none   | none   | Nested/secondary content     |
| Glass     | Paper at 80% with blur        | 1px    | `lg`   | Floating/overlay cards       |
| Elevated  | Paper `#FCFCF8`               | 1px    | `md`   | Feature cards, highlights    |
| Accent    | Green 100 or Blue 100         | 1px    | `sm`   | Callouts and helpful context |

## Properties

| Property    | Value                   |
|-------------|-------------------------|
| Radius      | 16px                     |
| Padding     | `lg` (24px)             |
| Border      | 1px solid `semanticColors.border` |
| Shadow rest | `sm`                    |
| Shadow hover| `md` (if interactive)   |

## States

| State    | Change                                          |
|----------|-------------------------------------------------|
| Default  | `shadow-sm`, static                              |
| Hover    | `shadow-md`, slight lift (if card is clickable)  |
| Active   | Scale 0.99 (if card is clickable)                |
| Selected | 2px border in `semanticColors.primary`, `shadow-md` |

## Sizing

Cards are fluid — they fill their container width. Control width via grid
or flex layout, not fixed widths on the card itself.

Minimum card width: 240px (prevents content from becoming illegible).

## Nesting

When nesting cards (e.g., a card inside a card), the inner card should use:
- Variant: `muted` (to differentiate from parent)
- Radius: 12px — one step smaller than the parent's radius
- Shadow: none (the parent provides elevation)

## Code Example

```tsx
<Card>
  <CardHeader>
    <CardTitle>Project Status</CardTitle>
    <CardDescription>Updated 2 hours ago</CardDescription>
  </CardHeader>
  <CardContent>
    <p>All systems running normally.</p>
  </CardContent>
  <CardFooter>
    <Button variant="secondary">Details</Button>
    <Button>Refresh</Button>
  </CardFooter>
</Card>
```

Glass variant:
```tsx
<Card className="bg-[rgba(252,252,248,0.80)] backdrop-blur-md shadow-lg">
  ...
</Card>
```

## Do's and Don'ts

**Do:**
- Use cards to group related content (not as decoration)
- Maintain consistent card sizes within a grid
- Use the glass variant only for floating/overlay contexts

**Don't:**
- Nest more than 2 levels of cards
- Put cards in cards in cards — flatten the hierarchy
- Use different radius values on cards in the same view
- Add heavy borders — the subtle 1px border is intentional
