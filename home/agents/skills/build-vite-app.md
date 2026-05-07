---
name: build-vite-app
description: Guide for building a Vite React app on Matrix OS
---

# Build a Vite React App

## Default UI Stack

First-party Matrix apps should use Tailwind CSS v4 and shadcn-style local primitives by default. Add this stack for polished apps:

```bash
pnpm add @tailwindcss/vite tailwindcss class-variance-authority clsx tailwind-merge lucide-react
```

- Configure Vite with `@tailwindcss/vite`; do not add `tailwind.config.js`
- Add a `@/*` TypeScript alias to `src/*`
- Create local `src/components/ui/*` primitives for Button, Card, Badge, Input, Textarea, Select, Tabs, Dialog, and Tooltip as needed
- Map Matrix CSS variables through Tailwind v4 `@theme inline`
- Use `lucide-react` icons in controls and status UI

## Scaffold

Copy the template and customize:

```bash
cp -r ~/apps/_template-vite ~/apps/{slug}
```

Edit `matrix.json`:
- Set `name`, `slug`, `description`, `category`
- Keep `runtime: "vite"` and `runtimeVersion: "^1.0.0"`
- Keep `listingTrust: "first_party"` and `build.output: "dist"`
- Do not convert CRM, roadmap, dashboard, or CRUD apps to Next.js/node runtime unless the user explicitly asks for Next.js or a custom server.

## Edit src/App.tsx

Replace the default content with your app. The component tree is standard React 19.

## Key Patterns

### Access Matrix OS Bridge

```tsx
// src/matrix-os.d.ts declares the typed window.MatrixOS surface
const response = await window.MatrixOS.query("What is the weather?");
```

### Theme Integration

Use CSS custom properties from the Matrix OS shell:

```css
color: var(--text-primary);
background: var(--bg-surface);
border: 1px solid var(--border-default);
```

### Tailwind v4 Theme Bridge

Use Tailwind v4 with Matrix tokens:

```css
@import "tailwindcss";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
}
```

### Build and Test

```bash
cd ~/apps/{slug}
pnpm install --prefer-offline
pnpm build
```

The app appears in AppViewer at `/apps/{slug}/` after building.

## Conventions

- `base: "./"` in `vite.config.ts` keeps asset URLs relative
- Source globs default to `["src/**", "public/**", "*.config.*", "index.html", "matrix.json"]`
- Build output goes to `dist/` and is served statically by the gateway
- The gateway serves `dist/index.html` for all routes (SPA fallback)
