---
name: matrix-vite-shadcn
description: Build first-party Matrix OS Vite React apps with Tailwind CSS v4 and shadcn-style primitives.
---

# Matrix Vite Shadcn

Use this when creating or upgrading Matrix apps under `~/apps/**`.

## Rules

- Use Vite + React + TypeScript.
- Use Tailwind CSS v4 with `@tailwindcss/vite`; do not add `tailwind.config.js`.
- Use shadcn-style local primitives for common controls: `Button`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Tabs`, `Dialog`, and `Tooltip` when needed.
- Use Matrix theme tokens as CSS variables and map them through `@theme inline`.
- Use `lucide-react` icons in buttons and status UI.
- Persist app state through `/api/bridge/data` unless a feature requires a gateway-owned API.

## Setup

```bash
pnpm add @tailwindcss/vite tailwindcss class-variance-authority clsx tailwind-merge lucide-react
```

Add `@/*` alias in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  }
}
```

Configure Vite:

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": "/src" } },
});
```

Use `src/index.css`:

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

## UX Defaults

- Build the actual app screen, not a landing page.
- Keep app shells dense and operational.
- Use cards for repeated items and real panels only; do not nest cards.
- Keep border radius at `rounded-lg` or tighter unless the existing app style requires otherwise.
- Use stable dimensions for toolbars, status cards, tabs, and controls so state changes do not shift layout.
- Build and verify the app with its own `pnpm build`; run the full default-app build only when no other app work is active.
