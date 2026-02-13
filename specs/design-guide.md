# Matrix OS Design Guide

A unified visual language for all Matrix OS surfaces: the desktop shell, the landing page, generated apps, and future mobile/native shells.

## Philosophy

Warm, approachable, slightly organic. Matrix OS is not a cold developer tool -- it's a personal operating system. The palette and textures draw from natural materials (terracotta, lavender, parchment) rather than neon/tech aesthetics. Glass-morphism and subtle blur create depth without heaviness.

## Color Palette

### Core Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--background` | `#ece5f0` | Page/canvas background (lavender) |
| `--foreground` | `#1c1917` | Primary text (warm black) |
| `--card` | `#ffffff` | Card/panel surfaces |
| `--card-foreground` | `#1c1917` | Text on cards |
| `--primary` | `#c2703a` | Primary action, accent (terracotta) |
| `--primary-foreground` | `#ffffff` | Text on primary |
| `--secondary` | `#f0eaf4` | Secondary surfaces (light lavender) |
| `--secondary-foreground` | `#44403c` | Text on secondary |
| `--muted` | `#f0eaf4` | Muted/background sections |
| `--muted-foreground` | `#78716c` | De-emphasized text (warm gray) |
| `--border` | `#d8d0de` | Borders (lavender tint) |
| `--ring` | `#c2703a` | Focus rings (matches primary) |

### Semantic Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--destructive` | `#ef4444` | Errors, delete actions |
| `--success` | `#22c55e` | Positive states |
| `--warning` | `#eab308` | Warnings |

### Accent Glow (for emphasis)

```css
rgba(194, 112, 58, 0.15)  /* terracotta glow, use behind badges/highlights */
```

## Typography

### Font Stack

| Role | Font | Variable |
|------|------|----------|
| Sans (UI text) | Inter | `--font-sans` / `--font-inter` |
| Mono (code, data) | JetBrains Mono | `--font-mono` / `--font-jetbrains` |

Both loaded via `next/font/google` for zero layout shift.

### Scale

- **Hero heading**: `text-6xl` to `text-8xl`, `font-bold`, `tracking-tight`
- **Section heading**: `text-3xl`, `font-bold`
- **Subheading**: `text-xl`, `font-light` or `font-medium`
- **Body**: `text-base` (`1rem`), `leading-relaxed`
- **Small/meta**: `text-sm` or `text-xs`, `text-muted-foreground`
- **Mono labels**: `font-mono text-xs tracking-widest uppercase`

## Border Radius

Base radius: `0.75rem` (`--radius`).

| Token | Value | Usage |
|-------|-------|-------|
| `rounded-sm` | `0.5rem` | Small chips, tags |
| `rounded-md` | `0.625rem` | Inputs, small buttons |
| `rounded-lg` | `0.75rem` | Cards, panels |
| `rounded-xl` | `1rem` | Feature cards, floating panels |
| `rounded-full` | `9999px` | Badges, pills, dots |

## Glass-morphism

Floating elements use frosted glass:

```css
bg-card/80 backdrop-blur-sm     /* standard glass panel */
bg-card/60 backdrop-blur-sm     /* lighter variant */
bg-card/90 backdrop-blur-sm     /* heavier, for input bars */
```

Always pair with `border border-border` for visible edges.

## Shadows

- **Cards**: `shadow-sm` (subtle lift)
- **Floating panels**: `shadow-lg` (pronounced)
- **Windows**: `shadow-2xl` (strong, macOS-like)
- **Inputs**: `shadow-xs` (barely visible)

## Background Pattern

The desktop uses a subtle SVG wave pattern on the canvas:

```css
background-image: url("data:image/svg+xml,...");  /* lavender wave strokes */
background-size: cover;
```

The landing page should use the same wave or a complementary organic texture that shares the same `#c8b8d0` stroke color at low opacity.

## Component Patterns

### shadcn/ui Configuration

- **Style**: `new-york`
- **Base color**: `neutral` (overridden by our custom palette)
- **CSS variables**: yes
- **Icon library**: lucide

All surfaces share the same shadcn component library.

### Buttons

```tsx
<Button>Primary Action</Button>                    /* bg-primary text-white */
<Button variant="outline">Secondary</Button>       /* border, transparent bg */
<Button variant="ghost">Tertiary</Button>           /* no border, hover only */
<Button variant="outline" size="sm" className="rounded-full">Chip</Button>
```

### Cards

```tsx
<Card className="rounded-xl">
  <CardHeader>
    <CardTitle>Title</CardTitle>
    <CardDescription>Subtitle</CardDescription>
  </CardHeader>
  <CardContent>...</CardContent>
</Card>
```

For glass-panel cards (floating):
```tsx
<Card className="bg-card/80 backdrop-blur-sm">
```

### Input Bar Pattern

Centered at bottom, glass panel, rounded:
```tsx
<div className="flex items-center gap-2 rounded-xl border border-border bg-card/90 px-3 py-2 shadow-lg backdrop-blur-sm">
  <Input className="border-0 bg-transparent shadow-none focus-visible:ring-0" />
  <Button size="icon">...</Button>
</div>
```

### Badges / Tags

```tsx
<Badge variant="outline" className="rounded-full border-primary/30 bg-primary/10 text-primary">
  Label
</Badge>
```

Mono-style tags (for technical/status indicators):
```tsx
<span className="font-mono text-xs tracking-widest uppercase text-primary">
  LABEL
</span>
```

### Dock / Sidebar

Left dock with icon buttons:
```tsx
<aside className="flex flex-col items-center gap-2 py-3 border-r border-border/40 bg-card/40 backdrop-blur-sm">
  <button className="size-10 rounded-xl bg-card border border-border/60 shadow-sm hover:shadow-md hover:scale-105">
    ...
  </button>
</aside>
```

### Window Chrome (macOS-style)

Traffic lights: red `#ff5f57`, yellow `#febc2e`, green `#28c840`, each `size-3 rounded-full`.

## Layout Guidelines

### Landing Page

- Max width: `max-w-6xl` (1152px) for full-width sections, `max-w-3xl` or `max-w-4xl` for content
- Section padding: `py-24 px-6`
- Section borders: `border-t border-border` between sections
- Nav: fixed top, glass panel (`bg-background/80 backdrop-blur-xl`)

### Desktop Shell

- Full viewport (`h-screen w-screen overflow-hidden`)
- Left dock, floating windows, bottom input bar
- Everything is `pointer-events-none` except interactive areas

## Dos and Don'ts

**Do:**
- Use the warm palette consistently -- lavender background, terracotta accent, white cards
- Add backdrop-blur on floating elements
- Keep corners rounded (`rounded-xl` for panels)
- Use Inter for all UI text, JetBrains Mono only for code/data
- Maintain generous whitespace

**Don't:**
- Use dark backgrounds (this is a light-mode OS)
- Use neon or high-saturation accent colors
- Use sharp corners (no `rounded-none`)
- Mix font families in the same element
- Add heavy gradients -- keep it flat with subtle depth from blur/shadow
