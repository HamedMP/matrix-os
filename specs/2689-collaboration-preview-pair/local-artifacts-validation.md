# Local preview artifact and profile primitives

Tracking: [ENG-418](https://linear.app/matrix-os/issue/ENG-418) and
[native stack 3026](https://github.com/HamedMP/matrix-os/stack/3026).
This layer separates the existing T021/T022 helpers from launcher #3088 to keep
each PR within the repository's 50-file limit. It adds no renderer, IPC handler,
user-facing command, permission change or new organization state.

The artifact client retains canonical Source lookup and independent GitHub
receipt/digest verification. Extraction retains its archive, traversal, symlink,
size and cleanup boundaries. Profile helpers retain owner/role separation,
exclusive creation, live-process leases and atomic retirement before deletion.
Only the already-pinned `tar` dependency is declared; the existing frozen
lockfile was installed successfully with pnpm 10.33.4 using cached packages.

All nine extracted helper/test files retain their exact reviewed blobs from
`9530c79c50869983a96a079df72b990ea17fc545`. The launcher keeps orchestration,
UI/main wiring, native E2E and the hosted/dedicated CI repair. The restart test
in parent #3086 waits for authorization completion after actual persistence.

Independent validation: seven filesystem/archive/client/authentication suites
passed 55 checks. All eight typechecks passed; the pattern scan reported zero
violations and five inherited warnings. The tests keep real local I/O, archive
parsing and race boundaries, with explicit synthetic Source/GitHub transport.
These results do not establish two-VPS, Clerk, model or native macOS acceptance.

The split preserves published commit ancestry through ordinary parent merges.
Native stack linking changes PR metadata and creates this layer without any
rebase. No customer data, sharing grants, cloud configuration, merge, deployment
or Slack post is part of this split. Recommend platform and Electron owner review.
