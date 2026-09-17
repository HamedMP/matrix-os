# Evidence Manifest

All evidence must be recaptured from the current PR head. Baseline images under ignored `output/` are diagnostic only and are not accepted as final evidence.

| Surface | Required states | Manifest |
| --- | --- | --- |
| Canvas Chat | unshared, owner, editor, viewer, attribution, queue, revoked, unavailable | `canvas-chat/README.md` |
| Canvas discussion | desktop overlay, narrow bottom sheet, unread, keyboard/focus | `canvas-discussion/README.md` |
| Canvas access | summary, management, snapshot/live distinction, inherited, feature-off | `canvas-access/README.md` |
| Canvas terminal | controller states, viewer, discussion, revoke, ineligible | `canvas-terminal/README.md` |
| Shared with me | badge, pending, accepted, empty/error/revoked/unavailable, native routing | `canvas-shared-with-me/README.md` |
| Cross-surface | Web Desktop, Electron, responsive web, supported mobile differences | `cross-surface/README.md` |

Each child manifest records commit SHA, command/fixture, viewport, account role, artifact path or PR upload URL, and the requirement demonstrated.
