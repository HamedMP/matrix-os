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

## Completed implementation scope

- Slice 1: short post-connect reconnect blips stay inside the shared five-second quiet window. `useConnectionHealth` owns the timer; `useSocket` derives usable state from that single store.
- Slice 2: outbound shell actions are queued with bounded TTL/cap behavior, deduped by action id, and tracked through metadata-only delivery states. The gateway emits `client:ack` for accepted/rejected message, approval, abort, and session-switch actions.
- Slice 3: active conversation runs are replayable after reconnect. The shell reattaches the active session on each socket-open epoch, replayed kernel events carry stable event ids, and duplicate replay events are ignored client-side.
- Slice 4: the main shell socket requires fresh live-connection credentials and retries credential refresh before opening `/ws`; it no longer falls into an unauthenticated reconnect loop when token refresh temporarily fails.
- Slice 5: shell connection diagnostics record bounded metadata-only snapshots for credential failures, websocket closes, recovery timing, route class, attempts, and visibility. Public websocket route probing is covered by the cloudflared websocket watchdog, which now emits a structured metadata-only public live-route diagnostic when `/ws` fails while the selected runtime is already known healthy.
- Slice 6: queued outbound work and completed replay buffers have explicit cap/TTL cleanup. Gateway closes detach active runs with a bounded reconnect grace instead of aborting immediately, so short deploy/restart/browser reconnects can replay.

## Remaining validation outside this PR

- Full SC-001 through SC-008 percentages require live browser/VPS chaos validation across network switching, sleep/wake, and deploy restart trials.
- Operator dashboards can consume the metadata categories and summary helpers now emitted/recorded, but this PR does not add a new dashboard panel.
- Terminal-specific reattach and stale terminal metadata remain under `specs/098-terminal-session-reliability/`.
