# Theme screenshot review

Captured from the shared React theme specimen and the actual Electron Appearance settings component in an isolated local preview. These are not screenshots of a deployed customer runtime. Before samples use the original registry; six presets previously fell back to dark in light mode.

## Reproduce the local review

From the repository root with Node 24+, pnpm and the workspace dependencies installed:

```sh
pnpm --dir desktop exec vite --config ../scripts/dev/theme-preview/vite.config.ts --port 5199
```

Open `http://127.0.0.1:5199/?view=gallery&mode=light` or change `mode=dark`. Gallery-only options: `stage=before` loads the historical registry; `stage=after` (default) loads the current registry; `theme=matrix` or `theme=matrix-neon` restricts the gallery to one preset. Use a 1440×1000 viewport and capture the full page for sheets and single-theme views; full-page output height expands with content.

Without `view=gallery`, the preview opens the actual Appearance controls. Gallery `mode`, `stage` and `theme` parameters do not configure Settings: it loads saved appearance from this origin's `localStorage["theme-review"]` fixture. Clear that key and reload for fresh Matrix Light defaults, then use the controls to select Dark or another preset. Capture Settings at 1440×1000; use browser device emulation at 390×844 for the phone viewport and verify no horizontal overflow.

For the custom fixture, choose Inter, create a custom theme based on Matrix, set the light Buttons colour to `#475926` and the dark Buttons colour to `#bed77b`, save, and reload to check persistence. These changes affect only the isolated local fixture, not a customer runtime. Browser full-page screenshot capture should retain the entire specimen/controls, including hover and status examples.

Run `bun scripts/dev/sync-theme-defaults.ts` from the repository root to refresh first-paint defaults from the shared Matrix theme. The script validates all stylesheet sections before writing targets. Validate with `pnpm exec vitest run tests/desktop/theme-defaults-sync.test.ts`.

## Full sheets

| Mode | Before | After |
| --- | --- | --- |
| Light | [Before](before-light-all.jpeg) | [After](after-light-all.jpeg) |
| Dark | [Before](before-dark-all.jpeg) | [After](after-dark-all.jpeg) |

## Individual samples

All 11 active presets are visible in each refreshed after sheet. The before sheets retain the original 14 presets. The original individual before/after samples remain available at [the preserved capture commit](https://github.com/HamedMP/matrix-os/tree/7dfc93a442de972b7a5993c404ab1f75b1c5e718/specs/626-theme-customization/evidence). The latest shared-palette correction is represented by the refreshed full sheets.

## Controls

[Custom colors and fonts](settings-custom.jpeg) · [Phone viewport](settings-mobile.jpeg)

The custom palette was saved and reloaded successfully. The 390px viewport had no horizontal overflow.

## Default Matrix refinement

[Matrix light](matrix-focus-light.jpeg) · [Matrix dark](matrix-focus-dark.jpeg) — neutral paper-white navigation in light mode, teal-900 navigation in dark mode, and neutral selection states.

[Matrix Neon light](neon-focus-light.jpeg) · [Matrix Neon dark](neon-focus-dark.jpeg) — neutral main actions, gold focus and meaningful coral/teal/gold/blue ANSI text. Hover, disabled and status tint specimens appear under every preset.
