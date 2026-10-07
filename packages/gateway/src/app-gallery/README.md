# Gallery filesystem boundary

The installer requires Node 24 on Linux with `/proc/self/fd` available. Other hosts fail closed with a generic 503 before reading or changing filesystem state. Node provides no portable `openat` equivalent; this feature deliberately has no macOS path-based fallback.

Directory handles are opened one component at a time with `O_DIRECTORY | O_NOFOLLOW`. Template/catalog reads and destination creates use paths relative to retained directory handles, so an ancestor rename or symlink swap cannot redirect an operation to a different directory. Files are read with bounded buffers and published exclusively as complete hard links. Private staging and the destination must share a filesystem.

Files are prepared under `data/app-gallery-staging`, a mode-0700 namespace denied by Matrix's ordinary owner file APIs. Four exclusive slots cap abandoned staging at four bounded template copies. Cleanup removes only installer-created files in that private namespace; it never deletes files or folders under visible `apps/` paths. Unknown private files preserve the slot for recovery. Privileged access and processes with direct filesystem access as the gateway's UID can modify this namespace; they are outside the ordinary file API isolation boundary.

The manifest is published last. A failed install can leave a bounded, manifest-free app folder. A later request returns a conflict and preserves it, including owner edits. Recovery requires an administrator to inspect and back up that incomplete folder before explicitly removing or moving it; retry does not silently replace it. Crashes can retain private slots, and four occupied slots stop further installs until reviewed recovery. There is no recursive cleanup or automatic visible-file rollback.

The installer injects the selected definition into `dist/index.html` and writes `src/definition.json`. Source `index.html` retains its single definition placeholder, so an owner rebuild uses the edited source definition rather than stale installer-injected HTML.
