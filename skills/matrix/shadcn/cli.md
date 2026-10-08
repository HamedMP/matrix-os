# shadcn CLI Reference

Configuration is read from `components.json`.

> **Matrix:** Use pnpm only. Replace `VERSION` with a reviewed eligible CLI version before executing an example; see [presets.md](./presets.md). For Matrix products choose Vite; other templates and force/reinstall flags below are general CLI reference, not an instruction to use them. Inspect help for the selected CLI version rather than assuming every flag is supported.

> **IMPORTANT:** Do not invent flags. This imported reference is a snapshot; check official docs and help for the selected eligible version when a command or flag is absent. The CLI auto-detects the package manager from the project's lockfile; there is no `--package-manager` flag.

## Contents

- Commands: init, add (dry-run, smart merge), search, view, docs, info, build
- Templates: next, vite, start, react-router, astro
- Presets: named, code, URL formats and fields
- Switching presets

---

## Commands

### `init` — Initialize or create a project

```bash
pnpm dlx shadcn@VERSION init [components...] [options]
```

Initializes shadcn/ui in an existing project or creates a new project (when `--name` is provided). Optionally installs components in the same step.

| Flag                    | Short | Description                                               | Default |
| ----------------------- | ----- | --------------------------------------------------------- | ------- |
| `--template <template>` | `-t`  | Template (next, start, vite, next-monorepo, react-router) | —       |
| `--preset [name]`       | `-p`  | Preset configuration (named, code, or URL)                | —       |
| `--yes`                 | `-y`  | Skip confirmation prompt                                  | `true`  |
| `--defaults`            | `-d`  | Use defaults (`--template=next --preset=base-nova`)       | `false` |
| `--force`               | `-f`  | Force overwrite existing configuration                    | `false` |
| `--cwd <cwd>`           | `-c`  | Working directory                                         | current |
| `--name <name>`         | `-n`  | Name for new project                                      | —       |
| `--silent`              | `-s`  | Mute output                                               | `false` |
| `--rtl`                 |       | Enable RTL support                                        | —       |
| `--reinstall`           |       | Re-install existing UI components                         | `false` |
| `--monorepo`            |       | Scaffold a monorepo project                               | —       |
| `--no-monorepo`         |       | Skip the monorepo prompt                                  | —       |

`pnpm dlx shadcn@VERSION create` is an alias for `pnpm dlx shadcn@VERSION init`.

### `add` — Add components

> **IMPORTANT:** To compare local components against upstream or to preview changes, ALWAYS use `pnpm dlx shadcn@VERSION add <component> --dry-run`, `--diff`, or `--view`. NEVER fetch raw files from GitHub or other sources manually. The CLI handles registry resolution, file paths, and CSS diffing automatically.

```bash
pnpm dlx shadcn@VERSION add [components...] [options]
```

Accepts component names, registry-prefixed names (`@magicui/shimmer-button`), URLs, or local paths.

| Flag            | Short | Description                                                                                                          | Default |
| --------------- | ----- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| `--yes`         | `-y`  | Skip confirmation prompt                                                                                             | `false` |
| `--overwrite`   | `-o`  | Overwrite existing files                                                                                             | `false` |
| `--cwd <cwd>`   | `-c`  | Working directory                                                                                                    | current |
| `--all`         | `-a`  | Add all available components                                                                                         | `false` |
| `--path <path>` | `-p`  | Target path for the component                                                                                        | —       |
| `--silent`      | `-s`  | Mute output                                                                                                          | `false` |
| `--dry-run`     |       | Preview all changes without writing files                                                                            | `false` |
| `--diff [path]` |       | Show diffs. Without a path, shows the first 5 files. With a path, shows that file only (implies `--dry-run`)         | —       |
| `--view [path]` |       | Show file contents. Without a path, shows the first 5 files. With a path, shows that file only (implies `--dry-run`) | —       |

#### Dry-Run Mode

Use `--dry-run` to preview what `add` would do without writing any files. `--diff` and `--view` both imply `--dry-run`.

```bash
# Preview all changes.
pnpm dlx shadcn@VERSION add button --dry-run

# Show diffs for all files (top 5).
pnpm dlx shadcn@VERSION add button --diff

# Show the diff for a specific file.
pnpm dlx shadcn@VERSION add button --diff button.tsx

# Show contents for all files (top 5).
pnpm dlx shadcn@VERSION add button --view

# Show the full content of a specific file.
pnpm dlx shadcn@VERSION add button --view button.tsx

# Works with URLs too.
pnpm dlx shadcn@VERSION add https://api.npoint.io/abc123 --dry-run

# CSS diffs.
pnpm dlx shadcn@VERSION add button --diff globals.css
```

**When to use dry-run:**

- When the user asks "what files will this add?" or "what will this change?" — use `--dry-run`.
- Before overwriting existing components — use `--diff` to preview the changes first.
- When the user wants to inspect component source code without installing — use `--view`.
- When checking what CSS changes would be made to `globals.css` — use `--diff globals.css`.
- When the user asks to review or audit third-party registry code before installing — use `--view` to inspect the source.

> **`pnpm dlx shadcn@VERSION add --dry-run` vs `pnpm dlx shadcn@VERSION view`:** Prefer `pnpm dlx shadcn@VERSION add --dry-run/--diff/--view` over `pnpm dlx shadcn@VERSION view` when the user wants to preview changes to their project. `pnpm dlx shadcn@VERSION view` only shows raw registry metadata. `pnpm dlx shadcn@VERSION add --dry-run` shows exactly what would happen in the user's project: resolved file paths, diffs against existing files, and CSS updates. Use `pnpm dlx shadcn@VERSION view` only when the user wants to browse registry info without a project context.

#### Smart Merge from Upstream

See [Updating Components in SKILL.md](./SKILL.md#updating-components) for the full workflow.

### `search` — Search registries

```bash
pnpm dlx shadcn@VERSION search <registries...> [options]
```

Fuzzy search across registries. Also aliased as `pnpm dlx shadcn@VERSION list`. Without `-q`, lists all items.

| Flag                | Short | Description            | Default |
| ------------------- | ----- | ---------------------- | ------- |
| `--query <query>`   | `-q`  | Search query           | —       |
| `--limit <number>`  | `-l`  | Max items per registry | `100`   |
| `--offset <number>` | `-o`  | Items to skip          | `0`     |
| `--cwd <cwd>`       | `-c`  | Working directory      | current |

### `view` — View item details

```bash
pnpm dlx shadcn@VERSION view <items...> [options]
```

Displays item info including file contents. Example: `pnpm dlx shadcn@VERSION view @shadcn/button`.

### `docs` — Get component documentation URLs

```bash
pnpm dlx shadcn@VERSION docs <components...> [options]
```

Outputs resolved URLs for component documentation, examples, and API references. Accepts one or more component names. Fetch the URLs to get the actual content.

Example output for `pnpm dlx shadcn@VERSION docs input button`:

```
base  radix

input
  docs      https://ui.shadcn.com/docs/components/radix/input
  examples  https://raw.githubusercontent.com/.../examples/input-example.tsx

button
  docs      https://ui.shadcn.com/docs/components/radix/button
  examples  https://raw.githubusercontent.com/.../examples/button-example.tsx
```

Some components include an `api` link to the underlying library (e.g. `cmdk` for the command component).

### `diff` — Check for updates

Do not use this command. Use `pnpm dlx shadcn@VERSION add --diff` instead.

### `info` — Project information

```bash
pnpm dlx shadcn@VERSION info [options]
```

Displays project info and `components.json` configuration. Run this first to discover the project's framework, aliases, Tailwind version, and resolved paths.

| Flag          | Short | Description       | Default |
| ------------- | ----- | ----------------- | ------- |
| `--cwd <cwd>` | `-c`  | Working directory | current |

**Project Info fields:**

| Field                | Type      | Meaning                                                            |
| -------------------- | --------- | ------------------------------------------------------------------ |
| `framework`          | `string`  | Detected framework (`next`, `vite`, `react-router`, `start`, etc.) |
| `frameworkVersion`   | `string`  | Framework version (e.g. `15.2.4`)                                  |
| `isSrcDir`           | `boolean` | Whether the project uses a `src/` directory                        |
| `isRSC`              | `boolean` | Whether React Server Components are enabled                        |
| `isTsx`              | `boolean` | Whether the project uses TypeScript                                |
| `tailwindVersion`    | `string`  | `"v3"` or `"v4"`                                                   |
| `tailwindConfigFile` | `string`  | Path to the Tailwind config file                                   |
| `tailwindCssFile`    | `string`  | Path to the global CSS file                                        |
| `aliasPrefix`        | `string`  | Import alias prefix (e.g. `@`, `~`, `@/`)                          |
| `packageManager`     | `string`  | Detected package manager (`npm`, `pnpm`, `yarn`, `bun`)            |

**Components.json fields:**

| Field                | Type      | Meaning                                                                                    |
| -------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `base`               | `string`  | Primitive library (`radix` or `base`) — determines component APIs and available props      |
| `style`              | `string`  | Visual style (e.g. `nova`, `vega`)                                                         |
| `rsc`                | `boolean` | RSC flag from config                                                                       |
| `tsx`                | `boolean` | TypeScript flag                                                                            |
| `tailwind.config`    | `string`  | Tailwind config path                                                                       |
| `tailwind.css`       | `string`  | Global CSS path — this is where custom CSS variables go                                    |
| `iconLibrary`        | `string`  | Icon library — determines icon import package (e.g. `lucide-react`, `@tabler/icons-react`) |
| `aliases.components` | `string`  | Component import alias (e.g. `@/components`)                                               |
| `aliases.utils`      | `string`  | Utils import alias (e.g. `@/lib/utils`)                                                    |
| `aliases.ui`         | `string`  | UI component alias (e.g. `@/components/ui`)                                                |
| `aliases.lib`        | `string`  | Lib alias (e.g. `@/lib`)                                                                   |
| `aliases.hooks`      | `string`  | Hooks alias (e.g. `@/hooks`)                                                               |
| `resolvedPaths`      | `object`  | Absolute file-system paths for each alias                                                  |
| `registries`         | `object`  | Configured custom registries                                                               |

**Links fields:**

The `info` output includes a **Links** section with templated URLs for component docs, source, and examples. For resolved URLs, use `pnpm dlx shadcn@VERSION docs <component>` instead.

### `build` — Build a custom registry

```bash
pnpm dlx shadcn@VERSION build [registry] [options]
```

Builds `registry.json` into individual JSON files for distribution. Default input: `./registry.json`, default output: `./public/r`.

| Flag              | Short | Description       | Default      |
| ----------------- | ----- | ----------------- | ------------ |
| `--output <path>` | `-o`  | Output directory  | `./public/r` |
| `--cwd <cwd>`     | `-c`  | Working directory | current      |

---

## Templates

| Value          | Framework      | Monorepo support |
| -------------- | -------------- | ---------------- |
| `next`         | Next.js        | Yes              |
| `vite`         | Vite           | Yes              |
| `start`        | TanStack Start | Yes              |
| `react-router` | React Router   | Yes              |
| `astro`        | Astro          | Yes              |
| `laravel`      | Laravel        | No               |

All templates support monorepo scaffolding via the `--monorepo` flag. When passed, the CLI uses a monorepo-specific template directory (e.g. `next-monorepo`, `vite-monorepo`). When neither `--monorepo` nor `--no-monorepo` is passed, the CLI prompts interactively. Laravel does not support monorepo scaffolding.

---

## Presets

Three ways to specify a preset via `--preset`:

1. **Named:** `--preset base-nova` or `--preset radix-nova`
2. **Code:** `--preset PRESET` (opaque code from the user or official Create interface; no assumed prefix)
3. **URL:** `--preset "https://ui.shadcn.com/init?base=radix&style=nova&..."`

> **IMPORTANT:** Never try to decode, fetch, or resolve preset codes manually. Preset codes are opaque — pass them directly to `pnpm dlx shadcn@VERSION init --preset <code>` and let the CLI handle resolution.

## Switching Presets

Follow [Presets](./presets.md) for new-product selection, eligible versions and preservation of existing components. Do not force reinitialize or reinstall local components as an automatic theme switch. Verify current CLI support: the official docs now include `apply PRESET`, selective theme/font application, and preset inspection commands; inspect a scratch-copy diff before applying mutations when no dry-run exists.
