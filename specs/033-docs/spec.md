# 033: Public Documentation (Fumadocs)

## Status: Draft

## Overview

Add public documentation at matrix-os.com/docs using Fumadocs, an MDX-based docs framework for Next.js App Router. Documentation lives in `www/content/docs/` as MDX files with frontmatter, rendered at `/docs` with sidebar navigation and built-in search. Scoped entirely within the existing `www/` package -- no changes to kernel, gateway, or shell.

## Task Range: T1100-T1108

## Parallel: YES

Independent of all other packages. Only touches `www/`.

## Deps: None

## Architecture

```
www/
  source.config.ts          -- NEW: Fumadocs collection definition
  mdx-components.tsx        -- NEW: MDX component defaults (required by Next.js MDX)
  .source/                  -- AUTO-GENERATED: typed content (gitignored)
  content/
    docs/
      meta.json             -- Sidebar navigation structure
      index.mdx             -- Intro page (/docs)
      getting-started.mdx   -- Getting started guide (/docs/getting-started)
  src/
    lib/
      source.ts             -- NEW: Fumadocs loader (page tree builder)
    app/
      docs/
        layout.tsx          -- NEW: DocsLayout + RootProvider (scoped to /docs)
        [[...slug]]/
          page.tsx          -- NEW: Dynamic catch-all MDX renderer
      api/
        search/
          route.ts          -- NEW: Search endpoint for Fumadocs search
```

## Key Design Decisions

### RootProvider scoped to /docs only
Fumadocs requires a `RootProvider` for theme/search context. This wraps only the `/docs` route segment, avoiding any conflict with ClerkProvider in the root layout. The root layout (`src/app/layout.tsx`) is NOT modified.

### Tailwind 4 integration
Fumadocs ships CSS that needs to be included. For Tailwind 4 (used in www/), this means:
- `@import "fumadocs-ui/css/neutral.css"` and `@import "fumadocs-ui/css/preset.css"` in globals.css
- `@source "../node_modules/fumadocs-ui/dist/**/*.js"` directive so Tailwind scans Fumadocs classes

### Content location
MDX files live in `www/content/docs/` following Fumadocs convention. This keeps content separate from source code and makes it easy for non-developers to contribute.

### Static generation
`generateStaticParams` pre-renders all doc pages at build time. No runtime MDX compilation.

### Middleware unaffected
The existing `proxy.ts` only protects `/dashboard` and `/admin` routes. `/docs` is public by default.

## Dependencies

```
fumadocs-core     -- Page tree, search, breadcrumbs, TOC
fumadocs-ui       -- Pre-built UI components (DocsLayout, DocsPage, etc.)
fumadocs-mdx      -- MDX content source with collection support
@types/mdx        -- TypeScript types for MDX
```

## Routing

| URL | Source |
|-----|--------|
| `/docs` | `content/docs/index.mdx` |
| `/docs/getting-started` | `content/docs/getting-started.mdx` |
| `/docs/*` | `content/docs/*.mdx` (extensible) |
| `/api/search` | Search endpoint |

## Content Schema

Each MDX file has frontmatter:
```yaml
---
title: Page Title
description: Brief description for SEO and sidebar
---
```

Sidebar ordering is controlled by `meta.json`:
```json
{
  "pages": ["index", "getting-started"]
}
```

## Future Extensions

- Add more doc sections: Architecture, API Reference, Channels, Skills, etc.
- Code syntax highlighting with Shiki (Fumadocs supports this out of the box)
- Versioned docs (Fumadocs supports multiple doc trees)
- i18n support
- OpenAPI integration for auto-generated API docs
