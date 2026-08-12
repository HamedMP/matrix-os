# Files List Action Layout Design

## Problem

In Desktop Files list view, the per-entry `More actions` button is absolutely
positioned at the row's right edge. The row grid currently ends with the
`Modified` column, so the button and the timestamp compete for the same pixels.
This makes the timestamp difficult to read and makes the action target feel
detached from the list structure.

## Approved Design

List view reserves a dedicated 32 px action column after `Modified`. The header
and every entry use the same four-column template: flexible name, fixed size,
fixed modified timestamp, and fixed actions. Grid view keeps its existing
top-right overlay because it has no tabular metadata columns.

The action button is visually quiet by default. It becomes fully visible when
the row is hovered, keyboard-focused, or selected. Its accessible name and
keyboard reachability remain unchanged, so hiding it visually must not remove
it from the accessibility tree.

## Alternatives Considered

1. Hide `Modified` while hovering the row. Rejected because metadata should not
   move or disappear when the user approaches an action.
2. Add right padding only. Rejected because the header and row would still have
   different alignment models, and narrow layouts could regress again.
3. Reserve a real action column. Selected because it gives the table one stable
   layout contract and works in compact and regular widths.

## Components and Data Flow

- `browser-views.tsx` defines the compact and regular four-column templates;
  `ComputerFileBrowser` selects the template for its compact state.
- `BrowserListing` renders an empty action header cell after `Modified`.
- `EntryButton` renders a matching empty action cell after the timestamp.
- `ManagedFileActionMenu` receives whether its entry is selected and forwards
  that visual state to `FileActionMenu`.
- `FileActionMenu` controls only button visibility; menu commands, capability
  gates, selection behavior, and right-click behavior do not change.

## Error and Boundary Behavior

There is no new network or filesystem behavior. Pending rows remain disabled.
Compact list view still truncates name/metadata within their own columns; the
action column never shrinks below 32 px. Grid view is unchanged except for the
same hover/focus/selected visibility treatment.

## Verification

- A failing rendered regression first proves the current list template has no
  action column and the button lacks the approved visibility states.
- The focused Desktop Files suites verify list/grid actions, keyboard focus,
  selection, pending disablement, and menu behavior.
- Desktop TypeScript, pattern checks, React Doctor, and production build remain
  required before the stacked PR is handed off.
