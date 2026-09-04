---
title: Button
description: Buttons trigger actions with one clear visual hierarchy.
status: stable
tokens:
  - semanticColors.primary
  - semanticColors.primaryForeground
  - semanticColors.surface
  - semanticColors.foreground
  - semanticColors.border
  - rounded.lg
  - rounded.full
---

# Button

Buttons are the primary way users trigger actions.

## Anatomy

```
┌─────────────────────────────┐
│  [icon]  Label  [icon]      │
└─────────────────────────────┘
   ↑               ↑
   leading          trailing
   (optional)       (optional)
```

## Variants

| Variant     | Background       | Text Color       | Border           | Use For                       |
|-------------|------------------|------------------|------------------|-------------------------------|
| Primary     | Teal 800         | Paper            | none             | The single main action        |
| Secondary   | Paper            | Ink              | Border           | Alternative actions           |
| Quiet/Ghost | transparent      | Ink              | none             | Toolbars and tertiary actions |
| Destructive | Coral 500        | Paper or Ink*     | none             | Confirmed destructive actions |

*Choose the text color that passes WCAG contrast at the rendered token value.

## Sizes

| Size  | Height | Padding X | Font Size | Icon Size |
|-------|--------|-----------|-----------|-----------|
| sm    | 32px   | 12px      | 0.8125rem | 14px      |
| md    | 40px   | 20px      | 0.875rem  | 16px      |
| lg    | 48px   | 28px      | 1rem      | 20px      |
| icon  | 40px   | 0 (square)| —         | 20px      |

## States

| State    | Change                                        |
|----------|-----------------------------------------------|
| Default  | As specified per variant                       |
| Hover    | Darken background 8%, elevate shadow to `sm`   |
| Active   | Scale to 0.98, shadow to `xs`                  |
| Focus    | 2px Gold 300 ring, offset 2px                   |
| Disabled | 40% opacity, `pointer-events: none`            |
| Loading  | Replace label with spinner, maintain width     |

## Shape

- Default radius: 12px
- Pill variant: `rounded-full` for chips, tags, and compact actions
- Never use sharp corners on buttons

## Usage Rules

1. **One primary button per decision area.** Use it only for the action that
   advances the user.
2. **Primary for section-level actions.** "Save", "Create", "Send" — the main
   thing the user came to do.
3. **Secondary for alternatives.** "Cancel", "Back", "Export" — present but
   not demanding.
4. **Ghost for toolbars and dense UI.** Icon-only buttons, inline actions,
   less prominent triggers.

## Code Example

```tsx
<Button>Save Changes</Button>
<Button>Get Started</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="ghost" size="icon"><Settings /></Button>
```

## Do's and Don'ts

**Do:**
- Use verb labels: "Save", "Create", "Send" (not "OK", "Submit")
- Maintain consistent sizing within a button group
- Show loading state when the action is async

**Don't:**
- Put two primary buttons next to each other
- Use long labels — keep to 1-3 words
- Disable without explanation (use a tooltip on the disabled button)
