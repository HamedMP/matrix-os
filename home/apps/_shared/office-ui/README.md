# office-ui

Dependency-free React 19 components for the Matrix OS office apps (Docs and
Sheets). Styling uses only the shared `--app-*` and `--identity-*` tokens, so
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
| `AppFrame` | `title?`, `titleBar?` (replaces the whole title row, e.g. a `DocumentTitleBar`), `titleIcon?`, `titleActions?`, `toolbar?`, `banner?` (e.g. a ReviewBar), `leftRail?`, `leftRailLabel?` ("Navigation"), `rightPanel?`, `rightPanelLabel?` ("Side panel"), `statusBar?`, `children` (main). Rails collapse under 720px. |
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
| `Popover` | `open`, `onClose`, `anchorRef`, `label`, `children`, `placement?` (`bottom-start` default). Escape and outside click close; focus returns to the anchor. A popover opened from inside another popover renders inside it, so clicks in the child never close the parent. |
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

## Ribbon

The tab row is the menu bar: File, Home, Insert ... sit on top and the active
tab's groups are laid out below it, each with its label underneath.

```tsx
const [tab, setTab] = useState("home");
const [collapsed, setCollapsed] = useState(false);

<AppFrame
  titleBar={<DocumentTitleBar appName="Docs" onHome={goHome} name={doc.name} onRename={rename} saveState={saveState} />}
  toolbar={
    <Ribbon
      activeTab={tab}
      onTabChange={setTab}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((value) => !value)}
      trailing={<ShareButton />}
      tabs={[
        { id: "file", label: "File", mode: "backstage", backstage: {
          items: [
            { id: "new", label: "New", render: ({ close }) => <NewPane onCreated={close} /> },
            { id: "open", label: "Open", render: () => <OpenPane /> },
            { id: "save", label: "Save", shortcut: "Ctrl+S", onSelect: () => save() },
            { id: "download", label: "Download", onSelect: () => downloadBytes(name, bytes, DOCX_MIME) },
          ],
        } },
        { id: "home", label: "Home", groups: [
          { id: "clipboard", label: "Clipboard", items: [
            { kind: "split", id: "paste", label: "Paste", size: "large", icon: <ClipboardPaste />, onClick: paste,
              menu: [{ id: "text", label: "Paste as plain text" }], onMenuSelect: pasteAs },
            { kind: "stack", id: "clip", rows: [[cutItem], [copyItem]] },
          ] },
          { id: "font", label: "Font", launcher: { label: "Font settings", onClick: openFontDialog }, items: [
            { kind: "stack", id: "font-rows", rows: [
              [familySelect, { kind: "select", id: "size", label: "Font size", value: size, editable: true, width: 56, options, onChange: setSize }],
              [{ kind: "toggle", id: "bold", label: "Bold", shortcut: "Ctrl+B", icon: <Bold />, showLabel: false, pressed: isBold, onToggle: setBold },
               { kind: "color", id: "color", label: "Font colour", value: color, allowNone: true, onChange: setColor }],
            ] },
          ] },
        ] },
      ]}
    />
  }
>
```

`Ribbon` props: `tabs`, `activeTab`, `onTabChange(id)`, `collapsed?`, `onToggleCollapsed?`
(enables double-click on a tab and the chevron button), `leading?`, `trailing?`, `label?`
("Ribbon", the tablist name), `backstage?` / `onBackstageChange?(state)` (controlled
backstage, `{tab, item} | null`; omit both to let the ribbon manage it), `className?`.

Tabs: `{id, label, groups}` for a panel tab, or `{id, label, mode: "backstage", backstage}`.
Groups: `{id, label, items, icon?, launcher?: {label, onClick, shortcut?}}`. `icon` is shown
on the group's overflow button; it falls back to the first item icon.

Every item has `id`, `label` (accessible name and tooltip), `shortcut?` (added to the
tooltip and `aria-keyshortcuts`) and `disabled?`. Kinds:

| `kind` | Extra props |
| --- | --- |
| `button` | `onClick`, `icon?`, `size?` (`small` default, `large` = icon above label), `showLabel?` (small only; false = icon only) |
| `toggle` | `pressed`, `onToggle(next)`, plus the button look props |
| `split` | `onClick` (primary half), `menu: DropdownItem[]`, `onMenuSelect(id)`, `menuLabel?` ("{label} options"), plus the look props |
| `menu` | `menu`, `onMenuSelect(id)`: a button that only opens a menu |
| `select` | `value`, `options: {value, label, style?}[]`, `onChange(value)`, `width?` (120), `editable?` (type a value; Enter or blur commits, Escape reverts), `placeholder?` |
| `color` | `value` (CSS colour or null), `onChange(color \| null)`, `icon?`, `palette?: {value, name}[]`, `allowNone?`, `noneLabel?` ("Automatic"). The face reapplies the current colour; the arrow opens the palette with recent colours (shared by all colour buttons, 8 at most) and a custom colour input. |
| `gallery` | `options: {id, label, preview?, style?}[]`, `value?`, `onSelect(id)`, `visible?` (4 shown inline, the rest under "More {label}") |
| `separator` | none |
| `stack` | `rows: RibbonItem[][]`: small items in stacked rows, e.g. a Font group with two rows |

Behaviour:

- **Overflow**: a ResizeObserver measures the row. When it is too narrow, groups collapse
  from the right into one button each that opens the group in a popover. The row never
  wraps and the content below never moves. The popover closes once a command ran (a
  button, a menu entry, a colour, a style); it stays open for a list and for a button
  that opens a menu.
- **Collapse**: double-click a tab or press the chevron to show tabs only. A tab click
  then shows the groups as an overlay until focus or a click leaves it, Escape is
  pressed, or the same tab is clicked again.
- **Keyboard**: the tabs use a roving tabindex (Left/Right/Home/End move, Enter/Space
  activate, Down enters the groups). Each group is one tab stop; Left/Right/Home/End move
  inside it. Form fields keep their own tab stop. Escape closes menus and popovers and
  returns focus to their button.
- **Backstage**: a `mode: "backstage"` tab opens a full-height panel from the ribbon's
  top edge down (the title bar stays visible). Items with `render(api)` show content on
  the right; items with `onSelect(api)` run at once and close the panel unless
  `keepOpen` is set. `api` is `{close(), select(id)}`. Escape and the back arrow close it;
  focus returns to the File tab. Set `backstage.defaultItem` for the first pane and
  `backstage.backLabel` for the back button name ("Back to document").

`fitGroups(available, fullWidths, collapsedWidths)` is the pure overflow rule.
`recentColors()` and `clearRecentColors()` read and reset the recent colour list.

## Title bar

| Component | Props |
| --- | --- |
| `BackToHome` | `label` (app name), `onClick`, `ariaLabel?` ("Back to {label} home"). Arrow plus name; the name hides under 520px. |
| `DocumentTitleBar` | `appName`, `onHome`, `name`, `onRename?(name)` (when set, clicking the name edits it; Enter or blur commits a trimmed, changed name; Escape cancels), `maxNameLength?` (255), `saveState?` (`saved`/`saving`/`unsaved`/`error`/`offline`), `saveLabel?`, `leading?`, `actions?`. Pass it to `AppFrame` as `titleBar`. |

## Local files

Plain browser APIs only, so they work in the sandboxed app iframe and in Electron
Desktop without `window.MatrixOS`.

```ts
import { DOCX_MIME, LocalFileError, downloadBytes, pickLocalFile } from "../../_shared/office-ui";

async function openFromComputer() {
  try {
    const file = await pickLocalFile({ accept: [".docx", ".txt", ".md"] });
    if (file) importDocument(file.name, file.bytes);
  } catch (error) {
    if (error instanceof LocalFileError) toast.show({ title: error.message, tone: "danger" });
    else throw error;
  }
}
downloadBytes("Report.docx", bytes, DOCX_MIME);
```

| Export | What it does |
| --- | --- |
| `pickLocalFile({accept, maxBytes?})` | Opens the system chooser through a hidden file input. Resolves `{name, bytes: Uint8Array, lastModified}`, or `null` on cancel (the `cancel` event, or focus returning without a file). Rejects with `LocalFileError` for the wrong type or a file above `maxBytes` (10 MiB). Call it from a click or key handler. |
| `readDroppedFile(dataTransfer, accept, {maxBytes?})` | Reads the one dropped file. Rejects with `LocalFileError` codes `no-file`, `multiple`, `wrong-type`, `too-large`, `read-failed`. |
| `downloadBytes(name, bytes, mimeType)` | Saves through a Blob URL and an anchor with `download`; the name is reduced to a plain file name and the URL is revoked afterwards. |
| `LocalFileError` | `code` plus a `message` that is safe to show, e.g. "Budget.xlsx is larger than 10 MB. Choose a smaller file." |
| `DOCX_MIME`, `XLSX_MIME`, `CSV_MIME`, `TSV_MIME`, `MAX_LOCAL_FILE_BYTES` | Constants. |
| `fileMatchesAccept(file, accept)`, `describeAccept(accept, maxBytes?)` | Helpers ("`.csv or .xlsx, up to 10 MB`"). |
| `FileDropZone` | `accept`, `onFile(file)`, `onReject(error)`, `maxBytes?`, `label?` ("Drop a file to open it"), `hint?`, `disabled?`. Shows a window overlay only while files from outside the page are dragged in; text, cell and image drags inside the document are untouched, and a drop another handler already took is ignored. Mount it once per app. |

## Start screen

`OfficeStartScreen` is the screen an office app shows with no file open. The
side column starts something new (template pages drawn by the app, plus
smaller actions such as "New from Markdown…") and holds the "From this
computer" tray; the main column lists recent files and browses the owner's
Matrix home. Mount the app's `FileDropZone` beside it: the tray tells the owner
they can drop a file anywhere. Styles live in `start.css`, imported by
`office-ui.css`.

| Export | What it does |
| --- | --- |
| `OfficeStartScreen` | `appName`, `artwork` (launcher image for the empty state), `notice?`, `status?` (floating "Opening…"), `busy?`, `create: {heading, templates: StartTemplate[] ({id, label, description?, preview}), onCreate(id), more?: StartAction[]}`, `local: {accept, noun, onChoose, maxBytes?}`, `recents: {heading, items, loading?, onOpen, onRemove, opening?, emptyHeadline, emptyDescription}`, `browser: {files, accept, onOpen, fileNoun, memory?}`, `kindOf(name)`. One column under 900px, with the templates as a compact strip. |
| `RecentFileList` | Recent files: typed page, name, folder, relative time. One tab stop; Up/Down/Home/End move, Enter opens, Delete or the row's remove button (Right arrow) forgets an entry; the entry stays until `onRemove` settles. |
| `MatrixFileBrowser` | One folder of `files.list` at a time: breadcrumbs, a name filter for the folder, sort by name or last change, folders first. Lists only folders and accepted extensions, never hidden entries, lock files (`~$`) or the protected `system` and `agents` folders. At the top of the home the other Matrix system folders (`apps`, `data`, `modules`, …; `SYSTEM_ROOT_DIRS`) are hidden behind a "Show system folders" switch. With `memory` (`createStartFolderMemory(MatrixOS)`, the app's own key-value store) it starts in the folder the owner last went to, else `documents`, else the home, and remembers each folder the owner goes to. Draws at most 200 rows and says so; a truncated listing is reported. Click a folder to enter, a file to open; Backspace goes up. Used on the start screen and inside the Open dialogs. |
| `FileThumb` | `kind` (`document`, `workbook`, `table`, `folder`), `tag?`, `size?`. |
| `start-model` helpers | `createStartFolderMemory`, `normalizeStartDir`, `startDirCandidates`, `hiddenSystemCount`, `browsableEntries`, `sortEntries`, `filterEntries`, `breadcrumbTrail`, `folderLabel`, `relativeTime`, `exactTime`, `extensionOf`. |

Template drawings use the `oui-art__*` classes (`paper`, `ink`, `accent`, `line`,
`soft`, `wash`, `rule`, `stroke`, `warn`) so they follow the theme.

## Colour

`--oui-accent` (the app's `--identity-accent`) is for filled surfaces, with
`--oui-on-accent` on top. For text, focus rings, outlines, borders and tints use
`--oui-accent-ink`: the accent drawn toward `--app-fg`, so it stays readable when a
dark host theme keeps the app's dark accent. In app styles write
`var(--oui-accent-ink, var(--identity-accent, var(--app-primary)))`;
`tests/default-apps/office-ui/accent-ink.test.ts` checks the kit, Docs and Sheets.

## Accessibility

All interactive parts are buttons or carry a role, have visible focus rings, close
on Escape where they float, and return focus to their trigger. Tests live in
`tests/default-apps/office-ui/`.
