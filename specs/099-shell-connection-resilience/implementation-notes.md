# Implementation Notes

## Slice 1: Short reconnect blips

This slice fixes the disruptive browser-shell reconnect state that appeared during brief live-socket interruptions. A post-connect reconnect under five seconds should not show the Matrix connection status toast, should not start runtime-health probing, and should not disable primary shell input that can be safely queued.

Expected user experience:

- Brief live-connection drops stay invisible while Matrix retries.
- The chat/input controls remain usable during the quiet reconnect window; safe sends are queued and replayed when the socket opens.
- If reconnecting lasts past five seconds, Matrix shows the existing non-blocking connection status and keeps the workspace open.
- User-facing copy stays generic and impact-focused. Raw route, provider, auth, filesystem, or gateway error details are not shown.

Focused automated tests:

- `pnpm exec vitest run tests/shell/connection-indicator.test.tsx tests/shell/useSocket-blip-resilience.test.tsx`
- `pnpm exec vitest run tests/shell/useSocket.test.ts tests/shell/connection-health.test.ts`
- `bun run check:patterns`

Manual verification:

1. Open the browser shell with an active chat input and at least one app/window open.
2. After the live socket has connected, force a WebSocket close and let it reconnect within five seconds.
3. Confirm no Matrix connection status toast appears, the typed draft remains editable, and the send control stays available.
4. Force the next reconnect attempt to stay unavailable for more than five seconds.
5. Confirm the non-blocking Matrix connection status appears, uses generic recovery copy, and does not cover or reset the workspace.
