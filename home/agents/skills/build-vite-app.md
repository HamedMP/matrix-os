---
name: build-vite-app
description: Guide for building a Vite React app on Matrix OS
---

# Build a Vite React App

## Scaffold

Copy the template and customize:

```bash
cp -r ~/apps/_template-vite ~/apps/{slug}
```

Edit `matrix.json`:
- Set `name`, `slug`, `description`, `category`
- Keep `runtime: "vite"` and `runtimeVersion: "^1.0.0"`

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

### Build and Test

```bash
cd ~/apps/{slug}
pnpm install
pnpm build
```

The app appears in AppViewer at `/apps/{slug}/` after building.

## Conventions

- `base: "./"` in `vite.config.ts` keeps asset URLs relative
- Source globs default to `["src/**", "public/**", "*.config.*", "index.html", "matrix.json"]`
- Build output goes to `dist/` and is served statically by the gateway
- The gateway serves `dist/index.html` for all routes (SPA fallback)
