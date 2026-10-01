# Private Chat path visibility

Tracking: ENG-55.

## Problem

The provider text projection replaces absolute filesystem paths before Chat stores assistant replies. That protects shared output but prevents the owner from using paths on their own VPS. The exact public routes `/api/apps` and `/api/integrations` were exempted in ENG-44; ordinary owner paths remain hidden.

## Behavior

- For a personal Chat without a collaboration scope, preserve complete absolute paths in Claude, Hermes, and coding-provider assistant replies and bounded tool previews. Keep credential assignments, Bearer values, and paths with query strings or fragments protected, including split streaming deltas and recovered Codex output.
- For a shared execution, retain the existing path projection. When a private Chat later becomes shared, project historical assistant messages, activity previews, and tool output text on shared reads without modifying the owner's stored data. Never release a partial historical assistant delta in a shared response.
- Event-cursor replay and events buffered during attachment carry metadata only. The client refetches current Chat detail rather than projecting a captured private event after the Chat has become shared. Live events may carry content through the owner projection.
- Public share previews and snapshots redact assistant paths and recognized credentials, including snapshots minted before this fix. Shared exports redact assistant paths and recognized credentials and do not decrypt protected tool output. Legacy private assistant messages mask recognized credentials on owner reads while preserving their complete paths.
- Existing redacted messages cannot be reconstructed. New private messages show paths only after the gateway update reaches the user's VPS.

## Boundary

Owning a VPS grants access to its files; it does not turn a Chat transcript into a private-only surface after the owner shares or exports it. Credential values remain hidden in assistant prose. Existing protected tool output is returned only through the authenticated personal-owner projection, with a collapsed tool-detail UI; recovering credentials removed from old assistant prose would require a separate protected storage and explicit reveal design.

## Validation

- Split-stream Claude, Hermes, and Codex tests cover private paths, shared paths, and credentials.
- Owner detail, shared collaboration history, public share snapshots, and export projections preserve the visibility boundary without mutating stored messages.
- Gateway typecheck and Electron Desktop against an exact-head Preview VPS are required before review.
