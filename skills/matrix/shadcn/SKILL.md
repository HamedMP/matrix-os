---
triggers: ["shadcn", "shadcn/ui", "components.json", "component preset", "shadcn charts"]
name: shadcn
description: Compose shadcn UI with project-aware components, coherent presets, accessible charts, and safe local updates.
version: 1.0.0
author: shadcn (owner-provided snapshot; Matrix adaptations)
platforms: [linux, macos]
related_skills: [matrix-app-builder, matrix-design-system, matrix-landing-design]
metadata:
  agent:
    tags: [Matrix OS, shadcn, components, presets, charts]
    related_skills: [matrix-app-builder, matrix-design-system, matrix-landing-design]
---

# shadcn/ui

A framework for building ui, components and design systems. Components are added as source code to the user's project via the CLI.

## Matrix integration

Use this pack when the app uses shadcn or the user requests it. Read only the relevant [CLI](cli.md), [customization](customization.md), [preset](presets.md), [chart](charts.md) and rule resources. The skill is documentation: it does not execute commands, install an MCP server, grant access, or supply project context automatically.

Generated Matrix products remain Vite/React/TypeScript with manifests and owner Postgres via `window.MatrixOS.db`. Preserve bridge, sandbox and responsive contracts. Use a coherent app-local style and semantic tokens; platform chrome/auth/billing keeps the shared Matrix brand. Use local/bundled fonts and icons; registry assets or font imports need review for CSP compatibility. Charts and dashboards need a real task and saved data, never decorative sample metrics.

Matrix uses pnpm only. In every example, replace `VERSION` with the explicitly selected reviewed CLI version that satisfies the project's minimum release age and registry policy; it is not a runnable version literal. Recheck eligible versions before use, inspect current docs and CLI help for that version, and record the exact choice. Never resolve an unreviewed latest tag implicitly. Run `pnpm install` from the project root after dependencies change and retain its lockfile. See [Presets](presets.md) for the dated verification and preservation workflow.

## Current project context

Read the existing package manifest, lockfile, `components.json`, CSS and local UI sources before using tools. If the active run permits CLI access, `pnpm dlx shadcn@VERSION info --json` can discover actual aliases, primitive base, styles and installed components. No context is injected by this skill. If CLI/network access is absent, report that limitation and inspect local sources; do not claim a fresh upstream check.

## Principles

1. **Use existing components first.** Use `pnpm dlx shadcn@VERSION search` to check registries before writing custom UI. Check community registries too.
2. **Compose, don't reinvent.** Settings page = Tabs + Card + form controls. A real data overview may combine Sidebar, Chart and Table; do not add a dashboard or card to every product.
3. **Use built-in variants before custom styles.** `variant="outline"`, `size="sm"`, etc.
4. **Use semantic colors.** `bg-primary`, `text-muted-foreground` — never raw values like `bg-blue-500`.

## Critical Rules

Apply these composition rules to compatible installed component APIs. Check the actual primitive base and version before adapting older projects. Each links to a file with Incorrect/Correct code pairs.

### Styling & Tailwind → [styling.md](./rules/styling.md)

- **`className` for layout, not styling.** Never override component colors or typography.
- **No `space-x-*` or `space-y-*`.** Use `flex` with `gap-*`. For vertical stacks, `flex flex-col gap-*`.
- **Use `size-*` when width and height are equal.** `size-10` not `w-10 h-10`.
- **Use `truncate` shorthand.** Not `overflow-hidden text-ellipsis whitespace-nowrap`.
- **No manual `dark:` color overrides.** Use semantic tokens (`bg-background`, `text-muted-foreground`).
- **Use `cn()` for conditional classes.** Don't write manual template literal ternaries.
- **No manual `z-index` on overlay components.** Dialog, Sheet, Popover, etc. handle their own stacking.

### Forms & Inputs → [forms.md](./rules/forms.md)

- **Forms use `FieldGroup` + `Field`.** Never use raw `div` with `space-y-*` or `grid gap-*` for form layout.
- **`InputGroup` uses `InputGroupInput`/`InputGroupTextarea`.** Never raw `Input`/`Textarea` inside `InputGroup`.
- **Buttons inside inputs use `InputGroup` + `InputGroupAddon`.**
- **Option sets (2–7 choices) use `ToggleGroup`.** Don't loop `Button` with manual active state.
- **`FieldSet` + `FieldLegend` for grouping related checkboxes/radios.** Don't use a `div` with a heading.
- **Field validation uses `data-invalid` + `aria-invalid`.** `data-invalid` on `Field`, `aria-invalid` on the control. For disabled: `data-disabled` on `Field`, `disabled` on the control.

### Component Structure → [composition.md](./rules/composition.md)

- **Items always inside their Group.** `SelectItem` → `SelectGroup`. `DropdownMenuItem` → `DropdownMenuGroup`. `CommandItem` → `CommandGroup`.
- **Use `asChild` (radix) or `render` (base) for custom triggers.** Check `base` field from `pnpm dlx shadcn@VERSION info`. → [base-vs-radix.md](./rules/base-vs-radix.md)
- **Dialog, Sheet, and Drawer always need a Title.** `DialogTitle`, `SheetTitle`, `DrawerTitle` required for accessibility. Use `className="sr-only"` if visually hidden.
- **Use full Card composition.** `CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`. Don't dump everything in `CardContent`.
- **Button has no `isPending`/`isLoading`.** Compose with `Spinner` + `data-icon` + `disabled`.
- **`TabsTrigger` must be inside `TabsList`.** Never render triggers directly in `Tabs`.
- **`Avatar` always needs `AvatarFallback`.** For when the image fails to load.

### Use Components, Not Custom Markup → [composition.md](./rules/composition.md)

- **Use existing components before custom markup.** Check if a component exists before writing a styled `div`.
- **Callouts use `Alert`.** Don't build custom styled divs.
- **Empty states use `Empty`.** Don't build custom empty state markup.
- **Toast via `sonner`.** Use `toast()` from `sonner`.
- **Use `Separator`** instead of `<hr>` or `<div className="border-t">`.
- **Use `Skeleton`** for loading placeholders. No custom `animate-pulse` divs.
- **Use `Badge`** instead of custom styled spans.

### Icons → [icons.md](./rules/icons.md)

- **Icons in `Button` use `data-icon`.** `data-icon="inline-start"` or `data-icon="inline-end"` on the icon.
- **No sizing classes on icons inside components.** Components handle icon sizing via CSS. No `size-4` or `w-4 h-4`.
- **Pass icons as objects, not string keys.** `icon={CheckIcon}`, not a string lookup.

### CLI

- **Never decode or fetch preset codes manually.** Pass them directly to `pnpm dlx shadcn@VERSION init --preset <code>`.

## Key Patterns

These are the most common patterns that differentiate correct shadcn/ui code. For edge cases, see the linked rule files above.

```tsx
// Form layout: FieldGroup + Field, not div + Label.
<FieldGroup>
  <Field>
    <FieldLabel htmlFor="email">Email</FieldLabel>
    <Input id="email" />
  </Field>
</FieldGroup>

// Validation: data-invalid on Field, aria-invalid on the control.
<Field data-invalid>
  <FieldLabel>Email</FieldLabel>
  <Input aria-invalid />
  <FieldDescription>Invalid email.</FieldDescription>
</Field>

// Icons in buttons: data-icon, no sizing classes.
<Button>
  <SearchIcon data-icon="inline-start" />
  Search
</Button>

// Spacing: gap-*, not space-y-*.
<div className="flex flex-col gap-4">  // correct
<div className="space-y-4">           // wrong

// Equal dimensions: size-*, not w-* h-*.
<Avatar className="size-10">   // correct
<Avatar className="w-10 h-10"> // wrong

// Status colors: Badge variants or semantic tokens, not raw colors.
<Badge variant="secondary">+20.1%</Badge>    // correct
<span className="text-emerald-600">+20.1%</span> // wrong
```

## Component Selection

| Need                       | Use                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Button/action              | `Button` with appropriate variant                                                                   |
| Form inputs                | `Input`, `Select`, `Combobox`, `Switch`, `Checkbox`, `RadioGroup`, `Textarea`, `InputOTP`, `Slider` |
| Toggle between 2–5 options | `ToggleGroup` + `ToggleGroupItem`                                                                   |
| Data display               | `Table`, `Card`, `Badge`, `Avatar`                                                                  |
| Navigation                 | `Sidebar`, `NavigationMenu`, `Breadcrumb`, `Tabs`, `Pagination`                                     |
| Overlays                   | `Dialog` (modal), `Sheet` (side panel), `Drawer` (bottom sheet), `AlertDialog` (confirmation)       |
| Feedback                   | `sonner` (toast), `Alert`, `Progress`, `Skeleton`, `Spinner`                                        |
| Command palette            | `Command` inside `Dialog`                                                                           |
| Charts                     | `ChartContainer` with Recharts primitives                                                          |
| Layout                     | `Card`, `Separator`, `Resizable`, `ScrollArea`, `Accordion`, `Collapsible`                          |
| Empty states               | `Empty`                                                                                             |
| Menus                      | `DropdownMenu`, `ContextMenu`, `Menubar`                                                            |
| Tooltips/info              | `Tooltip`, `HoverCard`, `Popover`                                                                   |

## Key Fields

The inspected project context contains these key fields:

- **`aliases`** → use the actual alias prefix for imports (e.g. `@/`, `~/`), never hardcode.
- **`isRSC`** → when `true`, components using `useState`, `useEffect`, event handlers, or browser APIs need `"use client"` at the top of the file. Always reference this field when advising on the directive.
- **`tailwindVersion`** → `"v4"` uses `@theme inline` blocks; `"v3"` uses `tailwind.config.js`.
- **`tailwindCssFile`** → the global CSS file where custom CSS variables are defined. Always edit this file, never create a new one.
- **`style`** → component visual treatment (e.g. `nova`, `vega`).
- **`base`** → primitive library (`radix` or `base`). Affects component APIs and available props.
- **`iconLibrary`** → determines icon imports. Use `lucide-react` for `lucide`, `@tabler/icons-react` for `tabler`, etc. Never assume `lucide-react`.
- **`resolvedPaths`** → exact file-system destinations for components, utils, hooks, etc.
- **`framework`** → routing and file conventions (e.g. Next.js App Router vs Vite SPA).
- **`packageManager`** → inspect project context; Matrix installs use pnpm (e.g. `pnpm add date-fns`).

See [cli.md — `info` command](./cli.md) for the full field reference.

## Component Docs, Examples, and Usage

Run `pnpm dlx shadcn@VERSION docs <component>` to get the URLs for a component's documentation, examples, and API reference. Fetch these URLs to get the actual content.

```bash
pnpm dlx shadcn@VERSION docs button dialog select
```

**When creating, fixing, debugging, or using a component and permitted tools are available, run `pnpm dlx shadcn@VERSION docs` and fetch the URLs first.** This ensures you're working with the correct API and usage patterns rather than guessing.

## Workflow

1. **Get project context** — inspect the project as described above. Run `pnpm dlx shadcn@VERSION info` again if you need to refresh.
2. **Check installed components first** — before running `add`, always check the `components` list from project context or list the `resolvedPaths.ui` directory. Don't import components that haven't been added, and don't re-add ones already installed.
3. **Find components** — `pnpm dlx shadcn@VERSION search`.
4. **Get docs and examples** — run `pnpm dlx shadcn@VERSION docs <component>` to get URLs, then fetch them. Use `pnpm dlx shadcn@VERSION view` to browse registry items you haven't installed. To preview changes to installed components, use `pnpm dlx shadcn@VERSION add --diff`.
5. **Install or update** — `pnpm dlx shadcn@VERSION add`. When updating existing components, use `--dry-run` and `--diff` to preview changes first (see [Updating Components](#updating-components) below).
6. **Fix imports in third-party components** — After adding components from community registries (e.g. `@bundui`, `@magicui`), check the added non-UI files for hardcoded import paths like `@/components/ui/...`. These won't match the project's actual aliases. Use `pnpm dlx shadcn@VERSION info` to get the correct `ui` alias (e.g. `@workspace/ui/components`) and rewrite the imports accordingly. The CLI rewrites imports for its own UI files, but third-party registry components may use default paths that don't match the project.
7. **Review added components** — After adding a component or block from any registry, **always read the added files and verify they are correct**. Check for missing sub-components (e.g. `SelectItem` without `SelectGroup`), missing imports, incorrect composition, or violations of the [Critical Rules](#critical-rules). Also replace any icon imports with the project's `iconLibrary` from the project context (e.g. if the registry item uses `lucide-react` but the project uses `hugeicons`, swap the imports and icon names accordingly). Fix all issues before moving on.
8. **Use an explicit registry** — prefer configured registries and official `@shadcn` components. Add a third-party registry only within the user's requested scope; inspect its added source, dependencies, assets and credential requirements. Never import provider credentials into app files.
9. **Presets preserve local work** — follow [Presets](presets.md). New products can choose one coherent preset once when the user delegates direction. Existing components, CSS, primitive base and app behavior must be preserved; do not reinitialize or force reinstall merely to try a random preset. A separately authorized replacement still needs a reviewed diff and backup.

## Updating Components

When the user asks to update a component from upstream while keeping their local changes, use `--dry-run` and `--diff` to intelligently merge. **NEVER fetch raw files from GitHub manually — always use the CLI.**

1. Run `pnpm dlx shadcn@VERSION add <component> --dry-run` to see all files that would be affected.
2. For each file, run `pnpm dlx shadcn@VERSION add <component> --diff <file>` to see what changed upstream vs local.
3. Decide per file based on the diff:
   - No local changes → safe to overwrite.
   - Has local changes → read the local file, analyze the diff, and apply upstream updates while preserving local modifications.
   - Explicitly authorized replacement → inspect the diff and preserve a backup before applying it.
4. **Never use `--overwrite` without the user's explicit approval.**

## Quick Reference

```bash
# New Matrix project: PRESET is a selected choice, not a fixed default.
pnpm dlx shadcn@VERSION init --name my-app --preset PRESET --template vite
pnpm dlx shadcn@VERSION init --name my-app --preset a2r6bw --template vite

# Add components.
pnpm dlx shadcn@VERSION add button card dialog
pnpm dlx shadcn@VERSION add @magicui/shimmer-button

# Preview changes before adding/updating.
pnpm dlx shadcn@VERSION add button --dry-run
pnpm dlx shadcn@VERSION add button --diff button.tsx
pnpm dlx shadcn@VERSION add @acme/form --view button.tsx

# Search registries.
pnpm dlx shadcn@VERSION search @shadcn -q "sidebar"
pnpm dlx shadcn@VERSION search @tailark -q "stats"

# Get component docs and example URLs.
pnpm dlx shadcn@VERSION docs button dialog select

# View registry item details (for items not yet installed).
pnpm dlx shadcn@VERSION view @shadcn/button
```

**Named presets:** `base-nova`, `radix-nova`
**Templates:** `next`, `vite`, `start`, `react-router`, `astro` (all support `--monorepo`) and `laravel` (not supported for monorepo)
**Preset codes:** Opaque codes supplied by the user or official [Create](https://ui.shadcn.com/create) interface. Do not assume a prefix or manually decode them; let the selected CLI validate them.

## Detailed References

- [rules/forms.md](./rules/forms.md) — FieldGroup, Field, InputGroup, ToggleGroup, FieldSet, validation states
- [rules/composition.md](./rules/composition.md) — Groups, overlays, Card, Tabs, Avatar, Alert, Empty, Toast, Separator, Skeleton, Badge, Button loading
- [rules/icons.md](./rules/icons.md) — data-icon, icon sizing, passing icons as objects
- [rules/styling.md](./rules/styling.md) — Semantic colors, variants, className, spacing, size, truncate, dark mode, cn(), z-index
- [rules/base-vs-radix.md](./rules/base-vs-radix.md) — asChild vs render, Select, ToggleGroup, Slider, Accordion
- [cli.md](./cli.md) — Commands, flags, presets, templates
- [customization.md](./customization.md) — Theming, CSS variables, extending components

- [presets.md](./presets.md) — coherent selection, release-age policy and preserving existing components
- [charts.md](./charts.md) — Recharts 3 composition, measurable containers and owner-saved data
- [mcp.md](./mcp.md) — optional tools only when configured in the current run
