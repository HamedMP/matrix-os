# Matrix themes and personal appearance

Make Matrix light the fresh-install default, independent of the operating system. Preserve explicit existing choices. Align Matrix with the [design library](https://matrix-os-design-library.vercel.app/library/foundations/colors): Geist, neutral actions, gold focus, teal success and coral errors. Extend its light scales to a neutral, layered dark mode.

- Share the preset registry, color derivation, font choices and customization controls across Web Canvas, Web Desktop and Electron Desktop. Web Mobile shares the web Settings surface. Native Mobile retains its platform theme controls; applying desktop typography and per-token customization is outside this renderer change.
- Supply both light and dark variants for the 11 active presets, preserve their recognizable hue families and enforce readable text contrast.
- Store one custom theme with separate light/dark overrides and a base preset; allow interface and monospace font choices. Keep values bounded, allowlisted and portable with existing appearance settings. Show save failures, retain drafts, and offer reset.
- Use existing authenticated settings/state transports; no endpoints or auth changes. Web owner settings remain in `system/theme.json`; Electron appearance remains in its existing state file.
- Capture before/after theme sheets and individual light/dark samples. Verify shared controls, hydration, persistence errors and text contrast.
- Deliver implementation PR and a separate public documentation PR in `FinnaAI/matrix-os-site`.

## Review boundaries

Source of truth: shared theme definitions and appearance settings. Persistence: existing atomic settings writes. Custom data is limited to one base id and ten hex colors. No app-data migration, wallpaper overwrite, customer rollout, or historical preference reset.

## Evidence and validation

- [Before/after screenshots for every preset](evidence/README.md), plus custom and responsive controls.
- All 22 active variants have small-text, button and editor-comment contrast checks. Custom foregrounds and cursors are adjusted against selected backgrounds.
- UI integration covers font changes and independent light/dark custom saves; Electron persistence tests exercise the actual state store and reject malformed values.
- Shared appearance applies to app chrome and editors. Terminal-specific settings retain their existing separate colors/font preferences.
- Native Mobile customization remains outside this change. Web Canvas and Web Desktop consume the same web Settings adapter; Electron Desktop consumes the same controls and registry.
- Companion website documentation is prepared in [the documentation draft](website-docs-draft.md) for a separate site PR.

## Matrix navigation refinement

Matrix remains first in the theme picker and the installation default in light mode. Its sidebar uses neutral paper-white with neutral selections in light mode and teal-900 navigation with neutral selections in dark mode. Chat and Settings consume the same sidebar tokens in Web Canvas, Web Desktop and Electron Desktop; old web theme files derive navigation tokens from their existing chrome colors.

[Light preview](evidence/matrix-focus-light.jpeg) · [Dark preview](evidence/matrix-focus-dark.jpeg)

## Designer review adjustments

Use exact Matrix brand scale steps for Matrix and Matrix Neon. Keep menu and button hover states visible, use neutral Matrix navigation states, separate semantic fills/tints/text, use 8px controls, and pass AA for secondary text on raised and selected surfaces and for status/button text. Neon retains green links/code/prompt, a neutral main action, gold focus, and coral/teal/gold/blue ANSI meanings.

Retire Tokyo Night, Solarized and Catppuccin. Saved preset IDs and custom bases fall back to Matrix while preserving light/dark/system mode; unrelated custom palettes remain saved. The eleven remaining presets need fresh light/dark designer sheets. Automated checks cover all preset text and semantic status pairs.
