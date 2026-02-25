# Tasks: Public Documentation (Fumadocs)

**Task range**: T1100-T1108
**Parallel**: YES -- www/ only. Independent of kernel/gateway/shell.
**Deps**: None.

## User Story

- **US-DOC1**: "Visitors to matrix-os.com/docs can read documentation about what Matrix OS is and how to get started"
- **US-DOC2**: "Developers can add new doc pages by creating MDX files in content/docs/ with no config changes"

## T1100: Install Fumadocs dependencies

- [ ] `pnpm add fumadocs-core fumadocs-ui fumadocs-mdx @types/mdx` in www/
- [ ] Verify package.json updated

## T1101: Source config + TypeScript paths

- [ ] Create `www/source.config.ts` (collection definition pointing to `content/docs/`)
- [ ] Update `www/tsconfig.json`: add `"@/.source": ["./.source"]` path alias
- [ ] Update `www/.gitignore`: add `.source/`

## T1102: Next.js config + MDX integration

- [ ] Update `www/next.config.ts`: wrap existing config with `createMDX()` from `fumadocs-mdx/next`
- [ ] Create `www/mdx-components.tsx`: export default Fumadocs MDX components

## T1103: Fumadocs loader

- [ ] Create `www/src/lib/source.ts`: loader using `fumadocs-core/source` with `baseUrl: '/docs'`

## T1104: CSS integration

- [ ] Update `www/src/app/globals.css`: add Fumadocs CSS imports after existing imports
  - `@import "fumadocs-ui/css/neutral.css"`
  - `@import "fumadocs-ui/css/preset.css"`
  - `@source "../node_modules/fumadocs-ui/dist/**/*.js"`

## T1105: Docs route files

- [ ] Create `www/src/app/docs/layout.tsx`: RootProvider + DocsLayout with sidebar/nav
- [ ] Create `www/src/app/docs/[[...slug]]/page.tsx`: DocsPage + DocsBody + DocsTitle + DocsDescription
  - Next.js 16 `Promise<>` params pattern
  - `generateStaticParams` for static generation
  - `generateMetadata` for SEO

## T1106: Search API

- [ ] Create `www/src/app/api/search/route.ts`: search endpoint using `createFromSource`

## T1107: Initial content

- [ ] Create `www/content/docs/meta.json`: sidebar navigation (`["index", "getting-started"]`)
- [ ] Create `www/content/docs/index.mdx`: intro page (what is Matrix OS, key concepts, links)
- [ ] Create `www/content/docs/getting-started.mdx`: quickstart (prerequisites, install, dev servers, first session)

## T1108: Verify

- [ ] `cd www && bun run dev` starts without errors
- [ ] http://localhost:3001/docs renders intro page with sidebar
- [ ] http://localhost:3001/docs/getting-started renders getting started page
- [ ] Sidebar navigation works (clicking between pages)
- [ ] Search dialog opens and returns results
- [ ] Existing routes unaffected: /, /login, /signup, /dashboard, /whitepaper
- [ ] `cd www && pnpm build` succeeds (Vercel compatibility)

## Implications

- `/docs` is public -- no auth required. Handled by existing middleware config.
- Root layout is NOT modified. Fumadocs providers are scoped to `/docs` route segment.
- `.source/` directory is auto-generated on dev/build and gitignored.
- Adding new pages: create MDX file in `content/docs/`, add to `meta.json` -- no code changes needed.
- Future: can expand to Architecture, API Reference, Channels, Skills, Deployment guides, etc.

## Checkpoint

- [ ] Docs render at /docs with sidebar navigation
- [ ] Search works
- [ ] Existing routes unaffected
- [ ] `pnpm build` succeeds
- [ ] New pages can be added by creating MDX + updating meta.json
