# Files

Files lets a user browse their Matrix home, create folders and files, and see them persist. Everything it shows is the owner's real home directory, so every create has an on-disk side effect.

## Sub-features

- `files-open` opens the Files window from the Desktop icon and lists the home root.
- `files-new-folder` creates a folder through `Create` > `New Folder`.
- `files-new-file` creates a file through `Create` > `New File` (it then opens the file).
- `files-persist` shows created items after a page reload.
- `files-locations` switches between sidebar locations (`Home`, `Agents`, `Apps`, `System`, `Plugins`, `Modules`, `Data`, `Trash`).

## How to get to it (user POV)

- Double-click the `Files` icon on the Desktop.
- App Launcher (`Open App Launcher` in the taskbar) > `Files`.
- Taskbar `Focus Files` / `Open Files` when it is already running.

## Driving it with matrix-verify

Preconditions:

- Baseline from `README.md`; `$V doctor` passes.
- No item named `verify-folder-*` or `verify-note-*` is required up front; the journey uses timestamped names.

- **Open Files (proven).** Double-click `Files` in `navigation "Desktop apps"`. A `group "File browser"` appears with `grid "File list"` containing a `gridcell "system"`.
- **New folder (proven).** Click `button "Create"` in the file browser, then `menuitem "New Folder"`. In `dialog "New folder"` fill `textbox "Folder name"` and click `button "Create folder"`. The dialog closes and `gridcell "<name>"` appears; `home("<name>")` exists on disk.
- **New file (proven).** `button "Create"` > `menuitem "New File"`, fill `textbox "File name"` in `dialog "New file"`, click `button "Create file"`. `home("<name>")` exists on disk.
- **Persistence (proven).** Reload the page; reopen Files if its window is not already restored. Both `gridcell`s are listed.
- **Run it.** `$V drive .agents/skills/verify-matrix/features/journeys/files-create.mjs`. Expect `result PASS` and screenshots `01-files-open` through `05-after-reload` plus `file-list.aria.txt`.
- **Locations (unproven).** Click a sidebar `button` such as `System`; the grid changes to that directory's entries.

## Gotchas

- The `Create` button can be briefly disabled right after a reload while the listing loads. Wait for a `gridcell` before clicking it.
- Creating a file opens it in another window that can cover the list. Prove the file through disk, then through the list after reload.
- Names are trimmed and limited to 128 characters by the dialog. Assert the listed name.
- Created items live in the scratch home and are deleted by `$V stop`; screenshots stay in evidence.
