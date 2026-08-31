# Plan Template

Every plan is written for an executor with **zero context from the audit and zero taste of its own**. If a value isn't in the plan, the executor will invent one — and it will invent a built-in easing curve and a 300ms duration.

Rules for filling this in:

- Inline every number. Never "the curve we discussed", never "a subtle scale", never "an appropriate duration".
- Quote the current code. The executor should be able to find the site by matching the excerpt, not by trusting a line number.
- Name an exemplar file in this repo that already does it right, so the executor copies the house style instead of inventing one.
- Bound the scope explicitly. Say what must not be touched.
- End with a feel-check, not just a build check. Code that compiles can still feel wrong.

---

```markdown
# NNN — <short imperative title>

- **Commit:** <git rev-parse --short HEAD>
- **Severity:** HIGH | MEDIUM | LOW
- **Category:** <one of the eight audit categories>
- **Estimated scope:** <n files, ~n lines>

## Problem

<Two or three sentences. What the motion does today, what it feels like, and the
rule it breaks. Name the rule — "ease-in on a UI interaction delays the exact
moment the user is watching" — not just "it feels slow".>

## Where

| File | Lines | What's there |
| --- | --- | --- |
| `src/components/dropdown.tsx` | 41–48 | Enter transition on the content |

### Current code

```tsx
// src/components/dropdown.tsx:41
<DropdownMenu.Content className="animate-in fade-in duration-300 ease-in">
```

## Target

<The exact end state. Every value spelled out.>

```css
.dropdown-content {
  transform-origin: var(--radix-dropdown-menu-content-transform-origin);
  transition:
    opacity 180ms cubic-bezier(0.19, 1, 0.22, 1),
    transform 180ms cubic-bezier(0.19, 1, 0.22, 1);

  &[data-starting-style],
  &[data-ending-style] {
    opacity: 0;
    transform: scale(0.95);
  }
}
```

**Why these values:** <one line per value — why 180ms, why this curve, why 0.95.>

## Conventions to follow

- Easing tokens live in `<file>`. Use `<token>`; add a new one only if none fits, following the naming already there.
- `<path/to/exemplar.tsx>` already does this correctly — match its structure.
- <Anything else the repo does its own way.>

## Steps

1. <One concrete action per step, in order.>
2. <…>
3. <…>

## Out of scope

- <Files or behaviors the executor must not touch.>
- Do not introduce a new animation library.
- Do not change any other component's timing, even if it looks similar.

## Verification

**Build**
- [ ] Type-check and lint pass.
- [ ] <Any test or story that covers this component.>

**Behavior**
- [ ] <Observable check — e.g. the panel scales from the trigger, not the center.>
- [ ] Trigger it rapidly: the motion retargets from its current position instead of restarting.
- [ ] With `prefers-reduced-motion: reduce` emulated in DevTools, nothing moves; opacity still transitions.

**Feel**
- [ ] Record it and scrub frame by frame. The curve should be steep at the start and settle gently — if it looks flat, the curve is too weak, not the duration.
- [ ] <For gestures and drawers:> test on a real device, not just the desktop browser.
- [ ] Look at it again with fresh eyes before calling it done.

## Notes

<Anything the audit couldn't judge from code — whether the bounce fits the brand,
whether the crossfade reads as one object. Say so plainly rather than guessing;
these are decisions for a human.>
```
