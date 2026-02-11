# Theme System Knowledge

## Theme File
`~/system/theme.json` defines the OS visual identity. The shell reads it and sets CSS custom properties on `:root`.

## CSS Custom Properties
All apps and modules inherit theme via CSS variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `--color-bg` | Background | `#0a0a0a` |
| `--color-fg` | Foreground text | `#ededed` |
| `--color-accent` | Primary accent | `#3b82f6` |
| `--color-surface` | Card/panel background | `#171717` |
| `--color-border` | Borders | `#262626` |
| `--color-muted` | Secondary text | `#737373` |
| `--color-error` | Error states | `#ef4444` |
| `--color-success` | Success states | `#22c55e` |
| `--color-warning` | Warning states | `#eab308` |
| `--font-mono` | Code font | `JetBrains Mono` |
| `--font-sans` | UI font | `Inter` |
| `--radius` | Border radius | `0.5rem` |

## Changing Themes
To change the theme, modify `~/system/theme.json`. The shell's file watcher detects the change and updates CSS variables in real-time.

## Custom Themes
Users can create theme files in `~/themes/` and switch by copying to `~/system/theme.json`.

## App Theme Integration
Apps should use CSS variables rather than hardcoded colors. This lets them automatically adapt when the theme changes.
