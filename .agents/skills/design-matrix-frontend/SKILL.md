---
name: design-matrix-frontend
description: Create distinctive, production-grade Matrix OS interfaces Triggers: build an app, create a UI, design an interface, make it look good, improve the design, style this, make it pretty, frontend.
---

# Design Matrix Frontend

When building any UI for Matrix OS, follow this skill to produce interfaces that are distinctive, polished, and cohesive with the OS aesthetic.

## Step 1: Design Thinking

Before writing any code, answer these four questions:

1. **Purpose**: What is this app for? What is the user's primary task?
2. **Tone**: Is this playful (game), productive (tool), informational (dashboard), or creative (editor)?
3. **Constraints**: Window size range, data volume, interaction patterns (touch? keyboard?).
4. **Differentiation**: What makes this app visually interesting? Avoid the default bootstrap look.

Commit to a BOLD aesthetic direction. Every app should have at least one distinctive visual element -- a unique header treatment, an unconventional card layout, an animated accent, a signature illustration style.

## Step 2: The Matrix OS Aesthetic

Matrix OS has a warm, organic, refined visual language. It draws from natural materials -- terracotta, lavender, parchment -- not from neon tech aesthetics.

Core traits:
- **Warm, not cold**: Lavender backgrounds, terracotta accents, warm blacks. Not gray-blue-white.
- **Organic, not mechanical**: Rounded corners, soft shadows, natural spacing. Not rigid grids with sharp edges.
- **Refined, not flashy**: Subtle depth via blur and shadow. Not gradient explosions or glow effects.
- **Glass-morphism**: Floating elements use `backdrop-filter: blur(8px)` with semi-transparent backgrounds.
- **Light by default**: The canvas is lavender `#ece5f0`. Cards are white. Text is warm black `#1c1917`.

## Step 3: Typography

### Rules
- Inherit `var(--matrix-font-sans)` for body text. Do not redeclare Inter.
- For display/hero text, choose a distinctive font. Load via Google Fonts or local.
- Pair a characterful display font with the system body font.

### Recommended Display Fonts
- **DM Serif Display**: Refined serif with personality. Great for headings.
- **Space Grotesk**: Geometric sans with character. Modern and warm.
- **Sora**: Rounded, friendly, distinctive sans-serif.
- **Fraunces**: Soft serif that matches the organic palette.
- **Outfit**: Clean geometric with slight playfulness.
- **Playfair Display**: Classic serif for editorial layouts.

### BANNED Fonts
Do not use these as deliberate font choices: Inter, Roboto, Arial, Helvetica, Open Sans, Segoe UI. These produce generic, undifferentiated UI. For body text, inherit the OS font via CSS variable.

### Scale
- Hero: `clamp(2rem, 5vw, 3.75rem)`, weight 700-800
- Section heading: `1.5rem-1.875rem`, weight 600-700
- Body: `1rem`, weight 400, `line-height: 1.6`
- Small/meta: `0.75rem-0.875rem`, weight 400-500
- Monospace labels: `font-family: var(--matrix-font-mono); font-size: 0.75rem; letter-spacing: 0.05em; text-transform: uppercase;`

## Step 4: Color

### Rules
- ALWAYS use `var(--matrix-*)` CSS variables. Never hardcode hex values.
- Pick a dominant color (usually the background) and a sharp accent (usually primary).
- Use semantic colors only for status: success, warning, destructive.

### Palette Strategy
- **Dominant**: `var(--matrix-bg)` -- the canvas, the breathing room
- **Accent**: `var(--matrix-primary)` -- terracotta, used sparingly for emphasis
- **Neutral**: `var(--matrix-card)` + `var(--matrix-border)` -- the content surfaces
- **Muted**: `var(--matrix-muted)` + `var(--matrix-muted-fg)` -- secondary information

### Creating Depth
Use the surface hierarchy:
1. Background (canvas) -- lowest
2. Card (content panels) -- raised with subtle shadow
3. Popover/Elevated (floating UI) -- highest, with blur and pronounced shadow

### Accent Glow
For highlighted elements (badges, selected items, featured cards):
```css
background: rgba(194, 112, 58, 0.1);
border: 1px solid rgba(194, 112, 58, 0.3);
```

## Step 5: Motion

Every well-built app includes these animation layers:

### Orchestrated Page Load
Stagger child elements with increasing delay for a polished entrance:
```css
.item { animation: fadeUp 0.3s ease-out backwards; }
.item:nth-child(1) { animation-delay: 0ms; }
.item:nth-child(2) { animation-delay: 60ms; }
.item:nth-child(3) { animation-delay: 120ms; }

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
```

### Hover Micro-interactions
Cards and buttons respond to hover with subtle movement:
```css
.interactive {
  transition: transform 0.15s ease-out, box-shadow 0.15s ease-out;
}
.interactive:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.1);
}
```

### Scroll-Triggered Reveals
Use IntersectionObserver to animate elements as they enter the viewport. Apply the same `fadeUp` keyframe, triggered by adding a `.visible` class.

### State Transitions
Expanding panels, toggling views, switching tabs -- all should animate:
- Enter: 150ms, ease-out
- Exit: 100ms, ease-in
- Only animate `transform` and `opacity`

### Reduced Motion
Always respect user preferences:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Step 6: Spatial Composition

Break free from rigid, predictable layouts:

### Asymmetry
Not every row of cards needs to be the same size. Use a featured item that spans two columns, or a hero card that is twice as tall.

### Generous Negative Space
White space is a design element. Do not cram content edge-to-edge. Let sections breathe with `padding: 32px` or more.

### Grid-Breaking Elements
Occasionally extend an element beyond its container -- a background accent that bleeds to the edge, or a decorative element that overlaps sections.

### Visual Hierarchy Through Size
The most important element should be the largest. Use size contrast to direct attention: a large hero stat, a small supporting label.

### Overlap and Layering
Stack elements with slight overlap using negative margins or absolute positioning. Cards that peek behind each other create depth.

## Step 7: Visual Details

The finishing touches that elevate an app from functional to polished:

### Glass-morphism
For floating or overlaid elements:
```css
background: rgba(255, 255, 255, 0.75);
backdrop-filter: blur(12px);
-webkit-backdrop-filter: blur(12px);
border: 1px solid rgba(255, 255, 255, 0.3);
```

### Subtle Shadows
Layer shadows for realistic depth:
```css
box-shadow:
  0 1px 2px rgba(0, 0, 0, 0.04),
  0 4px 12px rgba(0, 0, 0, 0.06);
```

### Noise Texture
For organic warmth, add a subtle noise overlay:
```css
background-image: url("data:image/svg+xml,..."); /* subtle grain */
```

### Geometric Accents
Decorative shapes (circles, lines, dots) as background elements. Use the primary color at low opacity.

### Gradient Meshes
Soft, multi-stop gradients as background accents:
```css
background: radial-gradient(ellipse at 20% 50%, rgba(194, 112, 58, 0.08) 0%, transparent 50%),
            radial-gradient(ellipse at 80% 20%, rgba(236, 229, 240, 0.5) 0%, transparent 40%);
```

## Step 8: Quality Checklist

Before declaring any UI complete, verify:

- [ ] **Responsive**: Works at 320px mobile through 1440px desktop
- [ ] **Themed**: Uses `var(--matrix-*)` for ALL colors, fonts, radii
- [ ] **Accessible**: Focus-visible rings, 44px touch targets, 4.5:1 contrast, semantic HTML, ARIA labels for icon buttons
- [ ] **Animated**: Page load stagger, hover effects, state transitions
- [ ] **Empty states**: Every list/grid handles zero items with icon + headline + description + CTA
- [ ] **Loading states**: Skeleton shimmer or spinner for async content
- [ ] **Error states**: User-friendly error messages, retry buttons
- [ ] **Keyboard**: Tab navigation works, Escape closes overlays, Enter activates buttons
- [ ] **Reduced motion**: Animations respect `prefers-reduced-motion`
- [ ] **Distinctive**: At least one visual element that makes this app memorable

## Anti-Patterns

### What NOT to Do

1. **Generic font stack**: Do not use `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` as a deliberate choice. Inherit `var(--matrix-font-sans)` or load something distinctive.

2. **Dark backgrounds**: Matrix OS is light by default. Do not set `background: #0a0a0a` or `#1a1a2e`.

3. **Blue primary buttons**: The Matrix OS accent is terracotta `var(--matrix-primary)`, not `#3b82f6`.

4. **Hardcoded colors**: Never write `color: #c2703a`. Always `var(--matrix-primary)`.

5. **Cookie-cutter card grids**: Identical 3-column grids with no visual hierarchy are boring. Vary card sizes, use featured items, add editorial spacing.

6. **No entrance animation**: Apps that pop in fully formed feel cheap. Stagger the entrance.

7. **Ignoring the palette**: Do not introduce random accent colors. Work within the warm palette: terracotta, lavender, cream, warm grays.

8. **Heavy borders**: Use `1px solid var(--matrix-border)` at most. The lavender-tinted border is barely visible by design.

9. **Flat, shadowless cards**: Cards need subtle shadow to float above the background. At minimum: `box-shadow: 0 1px 3px rgba(0,0,0,0.08)`.

10. **Purple gradients**: This was the old design language. The current system is warm (terracotta + lavender), not cool (purple + white).


## Matrix OS Context

- **Category**: development
- **Channels**: web
- **Composable with**: build-for-matrix, build-html-app, build-react-app, build-game
