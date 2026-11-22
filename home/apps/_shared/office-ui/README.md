# office-ui

Dependency-free React 19 components for the Matrix OS Mail, Calendar, Docs and
Sheets apps. Styling uses only the shared `--app-*` and `--identity-*` tokens, so
light and dark themes follow the Matrix theme bridge.

```ts
// src/main.tsx (once per app, before ./styles.css)
import "../../_shared/office-ui/office-ui.css";
// anywhere
import { AppFrame, ListView, ReviewBar } from "../../_shared/office-ui";
```

Apps must keep `resolve.dedupe: ["react", "react-dom"]` in `vite.config.ts` and
the React `paths` in `tsconfig.json` so these shared files use the app's React.
Icons are passed in as nodes (apps may use `lucide-react`); the kit itself ships
only a few inline SVGs.

## Components

Every component accepts `className`. `?` marks optional props.

| Component | Props |
| --- | --- |
| `AppFrame` | `title`, `titleIcon?`, `titleActions?`, `toolbar?`, `banner?` (e.g. a ReviewBar), `leftRail?`, `leftRailLabel?` ("Navigation"), `rightPanel?`, `rightPanelLabel?` ("Side panel"), `statusBar?`, `children` (main). Rails collapse under 720px. |
| `Toolbar` | `label`, `children`. role=toolbar; Left/Right/Home/End move focus. |
| `ToolbarGroup` | `label`, `children`. role=group. |
| `ToolbarButton` | `label` (name + tooltip), `icon?`, `showLabel?`, `pressed?` (aria-pressed), `shortcut?`, `variant?` (`default`/`primary`/`danger`), plus button attributes. Forwards its ref. |
| `ToolbarSeparator` | none. |
| `Dropdown` | `label` (trigger content), `ariaLabel?`, `items: DropdownItem[]` (`id`, `label`, `icon?`, `shortcut?`, `disabled?`, `danger?`, `separatorBefore?`, `checked?`), `onSelect(id)`, `align?`, `disabled?`. Menu button; arrows move; Escape closes and refocuses the trigger. |
| `SplitPane` | `label` (separator name), `first`, `second`, `direction?` (`horizontal` side by side, `vertical` stacked), `size?` (controlled px) or `defaultSize?` (320), `minSize?` (120), `maxSize?` (960), `onSizeChange?(px)`, `step?` (16; Shift x4). Pointer drag; arrows; Home/End. |
| `ListView<T>` | `label`, `items`, `getKey(item, i)`, `renderItem(item, {index, selected, active})`, `rowHeight` (px, fixed), `height?` (else measured), `selectionMode?` (`single` follows focus, `multiple`, `none`), `selectedKeys?`/`defaultSelectedKeys?`, `onSelectionChange?(keys)`, `activeKey?`, `onActiveChange?(key)`, `onActivate?(item, i)` (Enter/double click), `overscan?` (6), `emptyState?`. Virtualised listbox. Keys: arrows, Home/End, PageUp/PageDown, Space toggles, Shift extends, Ctrl/Cmd+A, Escape clears (multiple). Click, Ctrl/Cmd-click, Shift-click. |
| `TreeView` | `label`, `nodes: TreeNode[]` (`id`, `label`, `textValue?`, `icon?`, `badge?`, `children?`, `disabled?`), `selectedId?`, `onSelect?(id)`, `expandedIds?`/`defaultExpandedIds?`, `onExpandedChange?(ids)`. role=tree; arrows expand/collapse; type-ahead. |
| `Tabs` | `label`, `tabs: TabItem[]` (`id`, `label`, `icon?`, `badge?`, `closable?`, `closeLabel?`, `disabled?`), `activeId`, `onChange(id)`, `onClose?(id)` (also Delete key), `renderPanel?(id)`, `placement?` (`top`/`bottom` for sheet tabs), `trailing?`. |
| `Dialog` | `open`, `onClose`, `title`, `description?`, `children?`, `footer?`, `initialFocusRef?`, `size?` (`sm`/`md`/`lg`), `role?` (`dialog`/`alertdialog`), `dismissOnBackdrop?` (true), `showClose?` (true). Portal, focus trap, Escape, focus return. |
| `Popover` | `open`, `onClose`, `anchorRef`, `label`, `children`, `placement?` (`bottom-start` default). Escape and outside click close; focus returns to the anchor. |
| `Tooltip` | `content`, `children` (one element), `delay?` (500 ms hover; focus is immediate), `placement?` (`top`/`bottom`). |
| `ToastProvider` / `useToast()` | Wrap the app; `useToast()` returns `{ show({title, description?, tone?, action?: {label, onClick}, durationMs?}) => id, dismiss(id) }`. At most 5 toasts; oldest evicted. `ToastHost` is the presentational stack. |
| `EmptyState` | `headline`, `icon?`, `description?`, `action?` (`{label, onClick}` or a node), `secondaryAction?`. |
| `Spinner` | `label?` ("Loading"), `size?` (18). role=status. |
| `Skeleton` | `width?`, `height?` (12), `lines?`, `radius?`. aria-hidden. |
| `TextField` | `label`, `value`, `onChange(value)`, `type?`, `placeholder?`, `multiline?`, `rows?`, `hint?`, `error?`, `hideLabel?`, `disabled?`, `autoFocus?`, `maxLength?`, `id?`, `inputProps?`. |
| `Select` | `label`, `value`, `onChange(value)`, `options: {value, label, disabled?}[]`, `hint?`, `error?`, `hideLabel?`, `disabled?`, `id?`. Native select. |
| `Checkbox` | `label`, `checked`, `onChange(checked)`, `indeterminate?`, `disabled?`, `description?`, `id?`. |
| `Avatar` | `name`, `src?`, `size?` (28). Initials fallback (`initialsFor(name)` is exported). |
| `Badge` | `children`, `tone?` (`neutral`/`accent`/`success`/`warning`/`danger`). |
| `KeyHint` | `keys` (string or string[]). Renders `<kbd>`s. |
| `AgentPanel` | `onSubmit(prompt)`, `title?` ("Agent"), `messages?: {id, role: "user"|"agent", text}[]`, `statusLines?: {id, text, state: "pending"|"running"|"done"|"error"}[]`, `results?: {id, title, summary?, body?, status: "proposed"|"accepted"|"rejected", meta?}[]`, `onAccept?(id)`, `onReject?(id)`, `busy?`, `onCancel?` (shows Stop), `onClose?`, `suggestions?`, `placeholder?`, `disabled?`, `emptyHint?`, `maxLength?` (32000). Presentation only: no AI calls. Enter submits, Shift+Enter is a newline. |
| `ReviewBar` | `total`, `index` (0-based, -1 for none), `onPrevious`, `onNext`, `onAccept`, `onReject`, `onAcceptAll`, `onRejectAll`, `noun?` ("change"; e.g. "revision", "cell change"), `detail?`, `busy?`. Shows "3 of 12". |
| `ConfirmSend` | `open`, `onCancel`, `onConfirm()` (may return a promise), `kind?` (`mail`/`invite`), `title?`, `recipients?`, `summary?`, `confirmLabel?` ("Send"), `busy?`, `error?`. alertdialog; Cancel is focused first; a rejected promise shows "Could not send. Try again." and logs only the error name. |

`cx(...names)` joins class names.

## Accessibility

All interactive parts are buttons or carry a role, have visible focus rings, close
on Escape where they float, and return focus to their trigger. Tests live in
`tests/default-apps/office-ui/`.
