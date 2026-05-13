---
title: Dialog
description: Modals, sheets, and drawers for focused interactions.
status: stable
tokens:
  - colors.card
  - colors.foreground
  - colors.border
  - rounded.xl
  - shadows.xl
---

# Dialog

Dialogs interrupt the user to request information or confirmation.

## Types

| Type        | Position        | Width      | Use For                          |
|-------------|-----------------|------------|----------------------------------|
| Modal       | Center viewport | 400-560px  | Confirmations, forms, alerts     |
| Sheet       | Right edge      | 400-480px  | Detail views, side panels        |
| Drawer      | Bottom edge     | Full width | Mobile actions, pickers          |

## Anatomy (Modal)

```
┌──────────────────────────────────┐
│  ╳                               │  ← Close button (top-right)
│                                  │
│  Title                           │
│  Description                     │
│                                  │
│  ┌──────────────────────────────┐│
│  │ Content                      ││
│  └──────────────────────────────┘│
│                                  │
│       [Cancel]   [Confirm]       │  ← Footer actions
└──────────────────────────────────┘
```

## Properties

| Property    | Value                        |
|-------------|------------------------------|
| Radius      | `xl` (20px)                  |
| Shadow      | `xl`                         |
| Padding     | `lg` (24px)                  |
| Background  | `--card` (white)             |
| Border      | 1px solid `--border`         |
| Backdrop    | `rgba(50, 53, 46, 0.40)` blur 8px |

## Behavior (from UX Guide)

Every dialog MUST have three close mechanisms:
1. Close button (×) in the top-right
2. Click outside / backdrop click
3. Escape key

When a dialog opens:
- Focus moves into the dialog
- Focus is trapped (Tab cycles within)
- Body scroll is locked

When a dialog closes:
- Focus returns to the element that triggered it
- Animate out: 200ms ease-in

## Animation

| Event | Duration | Easing    | Transform                    |
|-------|----------|-----------|------------------------------|
| Enter | 200ms    | ease-out  | Scale 0.96 → 1, fade in     |
| Exit  | 150ms    | ease-in   | Scale 1 → 0.98, fade out    |

Sheets slide in from the right (300ms ease-out).
Drawers slide up from the bottom (250ms ease-out).

## Do's and Don'ts

**Do:**
- Use modals sparingly — they block the entire interface
- Put the primary action on the right, secondary on the left
- Use sheets for detail views that don't need full attention

**Don't:**
- Nest dialogs (a modal opening another modal)
- Use modals for content that could be inline
- Forget to return focus to the trigger on close
