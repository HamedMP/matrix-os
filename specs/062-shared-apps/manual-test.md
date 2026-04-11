# Manual Test — spec 062 (shared-apps)

> Integration test checkpoint for the shared-apps slice. Run this before marking the spec complete and before shipping any release that touches group / shared-app code. Screenshots go in `tests/e2e/screenshots/shared-app/` and are referenced here by filename.
>
> Scope: verify the end-to-end user journey across two Matrix OS accounts — create a group, invite a friend, share an app, collaborate in real time, survive network failure + crash recovery, and eject a member. Each section has an explicit **Expected state** that must all be true for the step to count as passing.
>
> Setup assumption: `bun run docker` is running locally with two browser tabs signed in as two distinct Matrix OS accounts (Alice and Bob). Gateway on `:4000`, shell on `:3000`. Both accounts have the notes app installed.

---

## Preconditions

TODO — enumerate the exact environment state required before running the checklist. Include:

- Gateway + shell + platform containers running (`bun run docker` or `bun run docker:full`).
- Two signed-in shells: Alice (`@alice:matrix-os.com`) in one browser profile, Bob (`@bob:matrix-os.com`) in another.
- Clean `~/groups/` for both users (no leftover state from previous runs).
- Notes app (`~/apps/notes`) installed in both accounts.
- DevTools open on both tabs with Console and Network visible.
- `docker compose logs -f gateway` tailing in a terminal so we can capture sync-loop warnings.

**Screenshots:** `preconditions-alice.png`, `preconditions-bob.png` (fresh shell on each side showing empty group switcher).

**Expected state:** TODO fill in (group switcher shows no groups, no errors in console, no 4xx/5xx in network tab, gateway log shows `MatrixSyncHub` started and idle).

---

## 1. Create group

TODO — walk through Alice creating a new group via the shell group switcher (e.g. "tuesday-club"). Cover:

- Click group switcher → "New group" → enter name + optional description.
- Observe the POST to `/api/groups` (201 response, body includes `slug`, `room_id`, `membership: "admin"`).
- Group appears in the switcher and is selected.
- `~/groups/<slug>/meta.json`, `members.json`, `acl.json` exist on Alice's side via `ls` in terminal app.

**Screenshots:** `01-create-group-form.png`, `01-create-group-success.png`, `01-create-group-fs.png`.

**Expected state:** TODO fill in (room created on Matrix homeserver, Alice shown as sole admin, group meta persisted, gateway log shows `group.created slug=<slug>`, no errors).

---

## 2. Join invite

TODO — Alice invites Bob; Bob accepts and syncs the group. Cover:

- Alice opens group members panel → Invite → enter `@bob:matrix-os.com`.
- POST `/api/groups/<slug>/invite` returns 200.
- Bob's shell receives Matrix invite notification; he clicks "Join".
- Bob's group switcher populates with the same group.
- Both sides' `members.json` contains both users after sync.
- Presence: each side shows the other as `online`.

**Screenshots:** `02-join-invite-alice-sends.png`, `02-join-invite-bob-accepts.png`, `02-join-members-both.png`.

**Expected state:** TODO fill in (both `members.json` equal, ACL still admin-only on Alice, Bob is `member`, no errors in either shell, gateway log shows `group.join slug=<slug> user=@bob:matrix-os.com`).

---

## 3. Share app

TODO — Alice shares the notes app into the group. Cover:

- Alice opens notes app → header → "Share to group" → picks the group.
- POST `/api/groups/<slug>/apps/notes/share` returns 200 and emits an `m.matrix_os.app_install` timeline event.
- Bob's shell installs shared entry automatically; notes app now appears in the group's shared app list on both sides.
- `~/groups/<slug>/apps/notes/meta.json` exists on both sides.
- ACL panel shows `admin` can read+write, `member` can read+write by default (confirm against spec default).

**Screenshots:** `03-share-app-alice-modal.png`, `03-share-app-bob-notification.png`, `03-share-app-acl-panel.png`.

**Expected state:** TODO fill in (app meta on both sides, ACL matches default, sync hub reports install event applied, no retries logged).

---

## 4. Concurrent edit

TODO — both users edit the same shared note at the same time and converge. Cover:

- Alice opens notes app → new shared note → types "hello from alice".
- Bob opens the same note (from his shared notes list) → types "hello from bob" at the end.
- Both tabs should converge to a single document containing both insertions in causal order.
- CRDT sync round-trip observed in DevTools network panel (`/ws/groups/<slug>/notes`).
- Server-side snapshot in `~/groups/<slug>/apps/notes/state/<note-id>.ybin` updates.

**Screenshots:** `04-concurrent-alice-before.png`, `04-concurrent-bob-before.png`, `04-concurrent-both-after.png`.

**Expected state:** TODO fill in (both shells show identical text, snapshot on disk matches in-memory doc, no divergence warnings in gateway log, no `shared.error` events surfaced to shell).

---

## 5. Offline + replay

TODO — disconnect Bob, edit on both sides, reconnect, verify replay. Cover:

- Bob: DevTools → Network → Offline.
- Alice edits shared note ("alice offline edit").
- Bob edits same note locally ("bob offline edit").
- Bob: Network → Online.
- Within 5s both sides converge to a document containing both edits.
- Gateway log shows queued ops drained from Bob's outbound queue.

**Screenshots:** `05-offline-bob-offline.png`, `05-offline-alice-edit.png`, `05-offline-bob-edit.png`, `05-offline-converged.png`.

**Expected state:** TODO fill in (queue drain observed, no snapshot corruption, no lease conflicts, no `shared.error` events on either side, all edits present in final state).

---

## 6. Crash recovery

TODO — kill the gateway mid-edit, restart, verify no data loss. Cover:

- Both users actively editing shared note.
- In a terminal, `docker compose kill gateway` (do NOT `down -v`).
- Both shells show a disconnected banner within 2s and stop accepting edits (or queue locally, depending on WS hook policy).
- `docker compose start gateway` — sync hub rehydrates, groups reload from disk, WS clients reconnect automatically.
- Post-recovery doc equals the last committed snapshot plus any queued client ops.
- No orphaned lease files, no corrupt `~/groups/<slug>/apps/notes/state/<note-id>.ybin`.

**Screenshots:** `06-crash-before.png`, `06-crash-banner.png`, `06-crash-recovered.png`.

**Expected state:** TODO fill in (shell auto-reconnects, snapshots intact, quarantine path never triggered, gateway log on restart shows `MatrixSyncHub resumed` and per-group `GroupSync rehydrate slug=<slug>`).

---

## 7. Kick + archive

TODO — Alice removes Bob and archives the group. Cover:

- Alice opens members panel → Bob → "Remove from group" → confirm.
- DELETE `/api/groups/<slug>/members/@bob:matrix-os.com` returns 200.
- Matrix `m.room.member` leave event propagates.
- Bob's shell removes the group from his switcher; his local `~/groups/<slug>/` is retained but marked archived (or removed, depending on spec decision — confirm).
- Alice archives the group via group settings → Archive.
- POST `/api/groups/<slug>/archive` returns 200; group disappears from active switcher on Alice's side.
- Shared app WS connections close cleanly.

**Screenshots:** `07-kick-bob-before.png`, `07-kick-bob-after.png`, `07-archive-alice.png`.

**Expected state:** TODO fill in (member removed from `members.json` on both sides, WS connections closed without error, archive flag written to `meta.json`, no crashes, no dangling timers or orphaned resources in gateway log).

---

## Cleanup

TODO — document how to reset between runs without nuking volumes. At minimum: close both browser tabs, sign out, `rm -rf ~/groups/*` in the gateway container for both user homes (via `docker compose exec gateway sh`), restart gateway.

Do NOT run `docker compose down -v` — volumes hold OS state, node_modules, and .next cache.
