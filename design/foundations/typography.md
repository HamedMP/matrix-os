---
title: Typography
description: Matrix OS font stack, type scale, and usage guidelines.
status: stable
---

# Typography

## Font Stack

| Role    | Font           | Variable          | Loaded Via          |
|---------|----------------|-------------------|---------------------|
| Display | Orbitron       | `--font-display`  | `next/font/google`  |
| UI      | Inter          | `--font-sans`     | `next/font/google`  |
| Code    | JetBrains Mono | `--font-mono`     | `next/font/google`  |

## When to Use Each Font

### Orbitron (Display)

Orbitron is the Matrix OS brand typeface — geometric, futuristic, immediately
recognizable. It signals "this is Matrix OS."

**Use for:**
- Logo lockup
- Hero headlines on landing/marketing pages
- Page titles in the shell (e.g., "Settings", "Mission Control")
- Onboarding headings
- App names in large formats (gallery, splash screens)

**Never use for:**
- Body text or paragraphs
- Button labels
- Navigation items
- Form labels or placeholder text
- Any text below 16px
- Inline with Inter in the same line

### Inter (UI)

Inter is the workhorse. All interactive and readable text uses Inter.

**Use for:**
- Body copy, descriptions, paragraphs
- Button labels, navigation, tabs
- Form labels, inputs, placeholders
- Card titles (h4 and below)
- Tooltips, toasts, alerts
- Metadata, timestamps, captions

### JetBrains Mono (Code)

**Use for:**
- Terminal output
- Code blocks and inline code
- Technical data (IDs, hashes, file paths)
- Mono-spaced labels (status badges, version numbers)

## Type Scale

| Level       | Font     | Size     | Weight | Line Height | Letter Spacing |
|-------------|----------|----------|--------|-------------|----------------|
| Display     | Orbitron | 3rem     | 700    | 1.1         | -0.02em        |
| H1          | Orbitron | 2.25rem  | 600    | 1.15        | -0.01em        |
| H2          | Orbitron | 1.75rem  | 600    | 1.2         | 0              |
| H3          | Inter    | 1.25rem  | 600    | 1.3         | 0              |
| H4          | Inter    | 1.125rem | 600    | 1.4         | 0              |
| Body        | Inter    | 1rem     | 400    | 1.6         | 0              |
| Body Small  | Inter    | 0.875rem | 400    | 1.5         | 0              |
| Caption     | Inter    | 0.75rem  | 400    | 1.4         | 0              |
| Label       | Inter    | 0.75rem  | 500    | 1.4         | 0.05em         |
| Mono        | JB Mono  | 0.875rem | 400    | 1.5         | 0              |

## Responsive Behavior

On viewports below 768px:

| Level   | Desktop  | Mobile   |
|---------|----------|----------|
| Display | 3rem     | 2rem     |
| H1      | 2.25rem  | 1.75rem  |
| H2      | 1.75rem  | 1.5rem   |
| H3      | 1.25rem  | 1.125rem |

Body, caption, and label sizes remain the same across breakpoints.

## Text Color

| Purpose              | Token                    |
|----------------------|--------------------------|
| Primary text         | `--foreground` (#32352E) |
| Secondary/meta text  | `--muted-foreground`     |
| Text on primary bg   | `--primary-foreground`   |
| Text on accent bg    | `--accent-foreground`    |
| Link text            | `--primary` (#434E3F)    |
| Link hover           | `--accent` (#D06F25)     |
| Disabled text        | `--muted-foreground` @ 60% opacity |

## Do's and Don'ts

**Do:**
- Use Orbitron for moments that say "Matrix OS"
- Use Inter weight 400 for body, 500 for labels, 600 for emphasis
- Use the Label style (uppercase, tracked, 0.75rem) for category tags
- Maintain consistent line heights for vertical rhythm

**Don't:**
- Mix Orbitron and Inter on the same line
- Use Orbitron below 16px (it becomes illegible)
- Use font weights below 400 (thin/light) — they don't read well on screens
- Center-align body text longer than 2 lines
- Use all-caps for anything except Labels and short status indicators
