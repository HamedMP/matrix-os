# Coherent presets and safe updates

For a new product, follow the user's reference or delegated visual direction. For a surprise/random request, choose once from suitable presets, inspect the resulting style, and record the exact preset, primitive base, semantic palette, type, shapes and motion in DESIGN.md. Keep that choice stable across screens, reloads and edits; different proposals can choose different families. A user-supplied example code is inspiration, not a default for every new app. If the user explicitly requests that code, honor it. Do not invent a `--random` CLI flag or decode a code yourself; use the selected CLI's documented preset tools or official Create interface.

Presets are a starting point for the actual product. Compose real components around its task; do not import sample dashboards, fictional statistics or another company's branding. Review fonts, icon dependencies and remote asset requests for Matrix's self-contained CSP. Scope tokens to the generated app and preserve platform branding.

## Version and package policy

Replace `VERSION` in command examples with an exact eligible reviewed version. Respect the project's minimum release age (Matrix repository: seven days), approved registry and lockfile; do not execute an unreviewed latest CLI automatically. Dated registry check on 2026-10-02 found shadcn 4.21.0 eligible while 4.21.1 was too recent. Recheck timestamps/eligibility and current help/docs before a later build; this observation is not a permanent pin. `pnpm dlx` is not governed by a project lockfile, so an explicit eligible CLI version matters. Preserve the package manager policy when adding component dependencies too; run `pnpm install` from the project root after dependency changes and inspect the lockfile.

For a new empty Matrix app, use Vite rather than implicit CLI framework defaults:

```sh
# VERSION and PRESET are placeholders for the selected recorded choices.
pnpm dlx shadcn@VERSION init --template vite --preset PRESET
pnpm dlx shadcn@VERSION add button input field dialog
```

Choose only components needed for the primary flow; do not use `add --all` as a default.

## Existing components and themes

Inspect `components.json`, installed UI source, project aliases, existing CSS, lockfile and DESIGN.md first. Retain the current primitive base and local behavior. Before upstream updates, use `add COMPONENT --dry-run` and `add COMPONENT --diff FILE` to inspect files, CSS and dependencies. Read the local changes, then merge the required upstream change while preserving them. Never force reinitialize, reinstall or overwrite to try a preset. A separately requested replacement requires explicit scope and a recoverable backup; ordinary refinements should preserve the existing components.

The current official CLI documents `apply PRESET` and selective `--only theme`/`--only font`, plus `preset resolve` and `preset decode`. Check support in the selected eligible version before using them. An apply can change CSS/config/components; inspect changes in a scratch copy when no non-mutating preview is available, then merge intentionally. Do not assume it preserves local work. Font-only application must still respect bundled/local font requirements.

After changes, verify imports, component composition, focus, touch hit areas, supported themes, reduced motion, responsive windows/mobile layouts, and actual saved-data flows. Record versions, preset and unavailable checks honestly. This guide grants no filesystem, network or MCP access; use only tools present in the current run.
