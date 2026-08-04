# Terminal sessions and recovery

Matrix OS terminal sessions have a stable runtime identity that is separate
from the name shown in the shell. Renaming a session changes its display
metadata; it does not replace the underlying runtime or its recovery history.
Canvas and Desktop use the same saved runtime identity.

## Interrupted sessions

When supervised terminal runtimes are enabled, a gateway restart or normal
Matrix OS update does not stop a live terminal. A host reboot or an unexpected
runtime failure can still leave a session in **Interrupted** or
**Recoverable** state. Matrix OS does not silently create a replacement.
Choose **Recover** explicitly.

Recovery restores valid Zellij layout, viewport, and bounded scrollback state.
Commands from a resurrected layout remain behind Zellij's confirmation prompt.
Matrix OS never uses `--force-run-commands`, and recovery never restarts a
coding agent automatically.

If saved history is missing, corrupt, incompatible, expired, or evicted,
recovery starts a fresh shell in the last validated folder. If that folder is
unavailable, it starts from the owner's home. The UI reports only a bounded
reason such as `history_unavailable` or `cwd_unavailable`; internal paths,
provider details, and raw service errors are not shown.

## Terminal-history privacy

Terminal output is owner data. Gateway scrollback and Zellij resurrection state
can retain commands, output, paths, credentials, tokens, and other secrets
printed in the terminal. Removing a one-shot launch descriptor does not erase
either history store.

Serialized history is bounded and subject to inactive retention and disk
pressure limits. Live receipts are not pruned. Explicitly deleting a terminal
session stops its complete runtime first, then erases that session's receipt,
gateway scrollback, and Zellij resurrection state after the runtime cgroup is
provably empty.

Avoid printing secrets when possible. Delete the session when its retained
history is no longer needed.
