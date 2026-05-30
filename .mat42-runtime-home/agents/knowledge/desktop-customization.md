# Desktop Customization Knowledge

## Theme System

### File: ~/system/theme.json

Defines the OS visual identity. The shell reads it on load and whenever it changes (via WebSocket file watcher), setting CSS custom properties on `:root`.

### Structure

```json
{
  "name": "default",
  "colors": {
    "background": "#faf5ff",
    "foreground": "#1c1917",
    "card": "#ffffff",
    "card-foreground": "#1c1917",
    "popover": "#ffffff",
    "popover-foreground": "#1c1917",
    "primary": "#c2410c",
    "primary-foreground": "#fafaf9",
    "secondary": "#f5f5f4",
    "secondary-foreground": "#1c1917",
    "muted": "#f5f5f4",
    "muted-foreground": "#78716c",
    "accent": "#f5f5f4",
    "accent-foreground": "#1c1917",
    "destructive": "#ef4444",
    "destructive-foreground": "#fafaf9",
    "border": "#e7e5e4",
    "input": "#e7e5e4",
    "ring": "#c2410c",
    "chart-1": "#c2410c"
  },
  "fonts": {
    "mono": "JetBrains Mono",
    "sans": "Inter"
  },
  "radius": "0.5rem"
}
```

### Color Keys

| Key | Purpose |
|-----|---------|
| background | Page/app background |
| foreground | Default text color |
| card | Card/panel surface |
| card-foreground | Text on cards |
| popover | Dropdown/tooltip surface |
| popover-foreground | Text on popovers |
| primary | Primary accent (buttons, links) |
| primary-foreground | Text on primary-colored elements |
| secondary | Secondary surface |
| secondary-foreground | Text on secondary surface |
| muted | Subtle backgrounds |
| muted-foreground | Subtle/secondary text |
| accent | Highlight/hover backgrounds |
| accent-foreground | Text on accent backgrounds |
| destructive | Error/danger actions |
| destructive-foreground | Text on destructive elements |
| border | Borders and dividers |
| input | Input field borders |
| ring | Focus ring color |
| chart-1 | Chart/graph primary color |

## Desktop Configuration

### File: ~/system/desktop.json

Controls the desktop background and dock layout.

### Structure

```json
{
  "background": {
    "type": "pattern",
    "pattern": "waves",
    "opacity": 0.08
  },
  "dock": {
    "position": "left",
    "size": 56,
    "iconSize": 36,
    "autoHide": false
  }
}
```

### Background Types

- **pattern**: SVG pattern overlay (default). Options: `pattern` (name), `opacity` (0-1)
- **solid**: Single color. Options: `color` (hex string)
- **gradient**: Two-color gradient. Options: `from` (hex), `to` (hex), `angle` (degrees, default 135)
- **wallpaper**: Image file. Options: `name` (filename in ~/system/wallpapers/)

### Dock Options

| Option | Type | Range | Default | Description |
|--------|------|-------|---------|-------------|
| position | string | left, right, bottom | left | Dock placement |
| size | number | 40-80 | 56 | Overall dock width/height |
| iconSize | number | 28-56 | 36 | Individual icon size |
| autoHide | boolean | true/false | false | Hide dock until hover |

## Available Presets

| Name | Description | Key colors |
|------|-------------|------------|
| default | Lavender canvas, terracotta accent | bg: #faf5ff, primary: #c2410c |
| dark | True dark, blue accent | bg: #09090b, primary: #3b82f6 |
| nord | Arctic blue-gray, frost accent | bg: #2e3440, primary: #88c0d0 |
| dracula | Dark purple, purple accent | bg: #282a36, primary: #bd93f9 |
| solarized-light | Warm cream, blue accent | bg: #fdf6e3, primary: #268bd2 |
| solarized-dark | Dark teal, blue accent | bg: #002b36, primary: #268bd2 |

## Common User Requests

| User says | Action |
|-----------|--------|
| "make it dark" | Write dark preset to ~/system/theme.json |
| "use nord theme" | Write nord preset to ~/system/theme.json |
| "move dock to bottom" | Update ~/system/desktop.json dock.position to "bottom" |
| "hide the dock" | Update ~/system/desktop.json dock.autoHide to true |
| "set background to blue" | Update ~/system/desktop.json background to {type:"solid", color:"#3b82f6"} |
| "set a gradient background" | Update ~/system/desktop.json background to {type:"gradient", from:"...", to:"..."} |
| "make icons bigger" | Increase ~/system/desktop.json dock.iconSize |
| "use X font" | Update ~/system/theme.json fonts.sans |
| "change accent color to green" | Update ~/system/theme.json colors.primary |

## Notes

- Use the `write_file` IPC tool to modify these files
- The shell detects file changes via WebSocket and applies immediately (no restart needed)
- Wallpapers are stored in ~/system/wallpapers/
- All changes persist across restarts (Everything Is a File)
- The theme.json color keys map directly to CSS custom properties (--color-{key})
- Apps and modules inherit theme via CSS variables automatically
