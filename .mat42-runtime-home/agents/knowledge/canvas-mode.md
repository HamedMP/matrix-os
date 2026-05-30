# Canvas Mode

Canvas mode transforms the desktop into an infinite pannable, zoomable workspace (like Miro or Figma).

## Navigation

- **Scroll wheel**: Zoom in/out at cursor position
- **Pinch-to-zoom**: Two-finger trackpad gesture
- **Space + drag**: Pan the canvas
- **Middle-click drag**: Pan the canvas
- **Cmd+0**: Fit all windows in view
- **Cmd+1**: Reset zoom to 100%
- **Cmd+=**: Zoom in
- **Cmd+-**: Zoom out

## App Groups

Users can create spatial groups by drag-selecting multiple app windows:
1. Click and drag on empty canvas to create a selection rectangle
2. Release to group the selected windows (minimum 2 windows)
3. Groups display as labeled dashed rectangles around their member windows

Group interactions:
- **Drag group header**: Move all member windows together
- **Double-click group header**: Zoom to fit the group
- **Click x on group header**: Delete the group (windows remain)

## Zoom Behavior

- **Above 60% zoom**: Full interactive windows with title bar, traffic lights, iframe content, resize handles
- **Below 60% zoom**: Preview cards showing title only (no iframe for performance)

## Toolbar

The top-center toolbar provides:
- Zoom slider (10% to 300%)
- Zoom in/out buttons
- Current zoom percentage (click to reset to 100%)
- Fit all button

## Minimap

Bottom-right corner shows a minimap with:
- Scaled window rectangles
- Group outlines
- Blue viewport indicator
- Click or drag to navigate

## Persistence

Canvas state (zoom, pan, groups) persists in `~/system/canvas.json` and auto-saves on changes.

## Chat Commands

Users can ask the AI to:
- "Switch to canvas mode" - Changes desktop mode to canvas
- "Group these apps together" - The AI can describe which apps to group
- "Zoom to fit" or "Show all windows" - Triggers fit-all
- "Create a group called Work" - Creates a named group
