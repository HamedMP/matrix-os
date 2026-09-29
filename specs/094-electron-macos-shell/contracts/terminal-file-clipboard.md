# Terminal local file transfer (ENG-41)

## User behavior

In macOS Electron Desktop Terminal, copying files in Finder and pressing Cmd+V
uploads their original bytes to the selected runtime. The terminal receives
generated remote file paths in one bracketed paste, without Enter. Native file
metadata takes precedence over clipboard text and clipboard-image previews.
Failures display a safe message instead of inserting the original file names.

Electron Desktop, Web Desktop and Web Canvas Terminal accept local file drags
using protected drag metadata. Reading actual files happens only on drop.
Ordinary text paste and screenshot/image clipboard paste retain their behavior.
An ordinary URI clipboard without native file metadata retains text paste.
Drops containing a folder or an unreadable file reject the entire batch with
feedback before uploading; supported items are never silently selected out.
An accessible **Attach files** icon sits beside the existing pane actions in
Electron Desktop, Web Desktop and Web Canvas. It opens a multi-file picker and
uses the same bounded upload flow; it is disabled while the terminal is
unavailable. Results from a picker opened for a different terminal are discarded.
The shared picker component and existing paste hook own this behavior; the
large Web Terminal composition only wires the hook's exported callback to it.

## Authorization and wiring

| Boundary | Authority | Public | Validation |
| --- | --- | --- | --- |
| `terminal:read-clipboard-files` IPC | The main window's exact trusted renderer and main frame | No | Strict empty request; no renderer-supplied paths |
| `POST /api/terminal/workspaces/:workspaceId/tabs/:tabId/paste-assets` | Existing gateway principal, configured runtime owner, exact workspace/tab access, project admission | No | Bounded JSON body, valid IDs, one asset per request, safe filename and MIME |
| Terminal input | The active authenticated terminal attachment | No | Operation generation and attachment identity must still match after clipboard read/upload |

Main reads only native macOS file-copy formats (`NSFilenamesPboardType`, with
`public.file-url` fallback), during user-initiated paste. The renderer receives
names and bounded file bytes, never local paths. The macOS property-list parser
accepts XML/binary metadata via stdin with a three-second timeout and a 64 KiB
cap. File reads reject symlinks, folders, devices and pipes, and remain bounded
even if a file grows while reading. Concurrent native reads are capped at one.

The renderer uploads each file through its existing authenticated runtime API.
Screenshot/image uploads omit `kind` (default `image`, strict magic/MIME
validation). Copied or dropped files set `kind: "file"`; their opaque bytes are
stored without requiring an image signature. The response includes the
owner-home-relative `path`, absolute `terminalPath`, `size`, and `mimeType`.

## Resource and persistence rules

- At most eight files per gesture, 10 MiB per file. Reject oversized batches
  rather than silently truncating them. Empty ordinary files are valid.
- Storage uses `temporary/terminal-pastes/<UTC date>/<generated ID><safe extension>`.
  Original names do not determine storage paths; extensions are bounded and
  validated. Files are exclusively created and atomically renamed.
- Existing 24-hour expiry, retained-file cap and recurring symlink-safe cleanup
  apply. Successful uploads abandoned after a terminal switch expire normally.
- No database writes or new file-fetch URLs are introduced.
- All user errors are fixed generic messages; local paths and raw errors are
  excluded. File-read failure stops paste rather than falling back to names.

## Validation and limits

Regression tests cover protected drag acceptance, arbitrary file bytes,
Unicode names, empty/missing MIME, count/size limits, owner rejection, native
Finder XML/binary metadata, unsafe file types, error fallback and stale terminal
destinations. Built Electron tests use the native clipboard, real Chromium file
drag events, the production upload route and an isolated filesystem; the
terminal runtime itself is a fixture.
The CI E2E job builds Electron first and then runs the required attachment suite;
the macOS Finder/URI clipboard cases also run in local macOS Electron validation.

Native file-copy paste is macOS-specific in this change. Windows/Linux retain
text/image paste and file drag/drop. Web clients cannot read Finder file paths
through this native bridge. Native Mobile and Web Mobile have no equivalent
native clipboard bridge in scope. Recursive folder upload,
and CLI-specific multimodal attachment syntax are deferred. Receiving a valid
remote path does not establish that every CLI treats it as an image attachment.
