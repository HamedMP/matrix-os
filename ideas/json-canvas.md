# JSON Canvas for Matrix OS

Source: https://jsoncanvas.org/spec/1.0/ (v1.0, 2024-03-11)

## Idea

Use JSON Canvas as a visual representation format within Matrix OS. Potential uses:
- Module dependency graphs (modules.json -> canvas visualization)
- Agent workflow visualization (task flows, agent routing)
- Knowledge maps (relationships between knowledge files)
- User-created canvases as a native app type in ~/apps/

## Spec Summary

Top level: `{ nodes: [...], edges: [...] }`

### Node types

| Type | Key fields | Use in Matrix OS |
|------|-----------|-----------------|
| `text` | `text` (markdown) | Notes, agent output summaries |
| `file` | `file`, `subpath` | References to ~/apps/, ~/modules/, ~/agents/ |
| `link` | `url` | External references, deployed module URLs |
| `group` | `label`, `background` | Grouping related modules, agent teams |

All nodes share: `id`, `type`, `x`, `y`, `width`, `height`, `color`

### Edges

Connect nodes: `fromNode`, `toNode`, `fromSide`, `toSide`, `fromEnd`, `toEnd`, `color`, `label`

### Colors

Preset: "1" red, "2" orange, "3" yellow, "4" green, "5" cyan, "6" purple. Also supports hex.

## Integration ideas

- Shell could render `.canvas` files natively (ModuleGraph component already planned)
- Kernel could auto-generate a canvas of the current system state
- Builder agent could output canvas files alongside apps to document architecture
- Canvas files stored in ~/data/ or ~/apps/ as first-class artifacts
