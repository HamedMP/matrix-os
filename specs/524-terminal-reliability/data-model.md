# State and data model

No persistent schema changes are proposed.

| Entity | Authority and relevant state |
|---|---|
| Terminal reference | Stable workspaceId/tabId pair; a view never grants creation or input authority |
| Runtime incarnation | Existing runtime supervisor; absent, starting, live, exited; transport loss does not imply process exit |
| Viewer | Connection-local; initializing, attached, closed; late initialization after close must be cleaned up |
| Controller lease | Gateway live ownership; writer/observer and epoch; graphical takeover changes authority, not process identity |
| Input queue | Transient per connection; paused, draining, closed; never persisted or migrated to a replacement connection |
| Output position | Runtime sequence/snapshot contract; client acknowledgement cannot advance beyond displayed/accepted output |
| Canonical grid | Runtime dimensions updated only by the authorized controlling path; observers adapt presentation |
| Saved presentation | Existing local/shared layout references; stale references reconcile without resurrecting deleted terminals |

Closed queues accept no further work. Input encoding and terminal-reference boundaries are preserved. Agent/controller authorization remains its existing separate contract; graphical observer semantics must not accidentally prohibit authorized headless agent operations.
