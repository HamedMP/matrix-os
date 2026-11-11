# 652 · Cross-surface notifications

Status: draft for review, rewritten 2026-11-10 around a mobile-first release train. Requester: Amin. Linear: none (standing waiver for tickets and the `#tech` post, recorded 2026-10-16).
Plan and diagrams: [Matrix OS Notifications Plan](https://claude.ai/artifact/NgqV44ZgDfSSLtcPxQ2GBG).

## Goal

Tell the owner when a chat reply finishes, when a run fails, when a task needs approval, and when an agent asks a question. Each alert appears once, on the surface the owner is using. The phone gets a push only when no computer or open app is in use. Reading or answering on any surface clears the other copies.

Today:
- Coding-agent alerts (Codex, Pi, OpenCode threads) fan out to every registered phone.
- Canonical chats (Claude, Hermes, OpenClaw, kernel, bots) never notify.
- Push tokens live in gateway memory and are lost on every restart.
- A notification tap always opens the home screen.

This spec replaces all of that with one gateway-owned router. It is delivered as a series of small releases, phone first.

## How we ship it

- **One small PR per release.** Each PR is reviewable on its own (target: under ~600 added lines with tests) and deployable on its own. No release depends on a later one to be safe.
- **Phone first.** Track A makes phone notifications correct and useful before any computer work starts. Until computers report presence (Track B), "still unread after a short wait" stands in for "the owner is away". Opening a chat on a focused, visible computer already marks it read (spec 123), so someone watching at their desk is not pushed.
- **One native build, early.** Every native change (Firebase config, channels, background push, entitlements, new native modules) goes into release A3. Everything else on Native Mobile ships over the air with EAS Update.
- **Ship paths.** Gateway changes go out in the host bundle (`dev` → `canary` → `stable`). Platform changes go out in the platform deploy. Native Mobile JS goes out with EAS Update, and native changes go through TestFlight and Play.
- **Kill switch.** From A4, `MATRIX_NOTIFICATIONS_ROUTER=off` in `/opt/matrix/env/host.env` turns the router off on a VPS. The legacy coding-agent bridge then runs as it does today. The legacy bridge is deleted only in A8a, once the router has run on `stable` for a full release.
- **Defaults never surprise.** A release never turns on a new kind of push for owners who have not enabled push on their phone.

## Release train

| ID | Release | Code | Ships via | Needs | What the owner gets |
| --- | --- | --- | --- | --- | --- |
| A1 | Tapping a notification opens the right chat | `apps/mobile` | EAS Update | none | Existing coding-agent pushes open the exact thread or chat from warm or cold start, on the right computer once pushes name it (A2). No banner for the chat already on screen. |
| A2 | Push tokens survive restarts | gateway | host bundle | none | Pushes keep working after gateway updates and restarts, and name the computer they came from |
| A3 | One native build | `apps/mobile` | TestFlight, Play | none | Android receives pushes. Channels, background push and the Time Sensitive capability are in place for later releases. |
| A4 | Approvals and questions from every chat | gateway | host bundle | A2 | Every harness notifies when it needs the owner, not only Codex, Pi and OpenCode threads |
| A5 | Reading on the phone counts as read | `apps/mobile` | EAS Update | none | Reading a chat on the phone advances the same read cursor as the computers |
| A6 | Replies and failures, only if still unread | gateway | host bundle | A4, A5 | A push when a reply finishes, unless the owner already read it anywhere |
| A7a | Notification preferences API | gateway | host bundle | A4 | none on its own |
| A7b | Notifications screen | `apps/mobile` | EAS Update | A7a | The owner controls kinds, phone timing and previews |
| A8a | Resolve and dismiss events | gateway | host bundle | A6 | none on its own |
| A8b | Clear and badge on the phone | `apps/mobile` | EAS Update | A3, A8a | Answering or reading anywhere removes the phone notification; the app icon shows a count |
| B1 | Presence socket | gateway | host bundle | A6 | none on its own (dark launch) |
| B2 | Electron reports activity and shows banners | `desktop/` + small gateway change | desktop OTA + host bundle | B1 | Banner on the laptop and a quiet phone while the owner is active in Electron |
| B3 | Web reports activity and shows banners | `shell/` | host bundle | B1 | The same for Web Desktop and Web Canvas |
| B4 | Notifications section on computers | `shell/`, `desktop/` | host bundle, desktop OTA | A7a, B2, B3 | The same settings on every surface |
| B5 | The open phone app counts as active | `apps/mobile` | EAS Update | B1 | An in-app banner instead of a push while the app is open |
| C1 | Platform device registry | `packages/platform` | platform deploy | none | none on its own |
| C2 | The app registers with the platform too | `apps/mobile` | EAS Update | C1 | none on its own (dual registration) |
| C3 | Platform push relay and receipts | `packages/platform` | platform deploy | C1 | none on its own |
| C4 | The gateway sends through the relay | gateway | host bundle | C2, C3 | Same behaviour. Dead tokens are cleaned up centrally. |
| C5 | Expo access token on, direct path removed | config, gateway, `apps/mobile` | EAS dashboard, host bundle | C4 on every VPS | Nobody can send to a device just by knowing its token |
| C6 | Approve, Deny and quick reply from the notification | `apps/mobile`, gateway | EAS Update, host bundle | A8b, C4 | Act without opening the app (unlock required) |
| C7 | Web Push for closed tabs | `packages/platform`, `shell/` | platform deploy, host bundle | C3, B3 | Browser alerts with no tab open, for owners without the app |

Track A can start today. Track B starts after A6, because B2 adds a step to the router that A4 and A6 build. Track C can run alongside Track B, but C5 waits until every VPS runs C4.

Estimated effort (engineer-days): Track A 15–20, Track B 11–16, Track C 15–20. Native Mobile releases (A1, A3, A5, A7b, A8b, B5, C2) can run in parallel with gateway releases.

### Release details

**A1 · Tapping a notification opens the right chat** (`apps/mobile/lib/push.ts`, `app/_layout.tsx`)
- Parse `data` with a Zod schema that accepts both today's shape (`{ category, threadId?, chatId?, handle? }`; A2 adds `handle`) and the v1 shape (`{ v: 1, notificationId, handle, target }`). An invalid payload opens the chat list.
- If `handle` is present and differs from the active computer, switch computers first. Without `handle` (a VPS before A2), open the target on the active computer; if it isn't found there, open the chat list rather than guess.
- Chats: `selectChat(chatId)`, then show the chats tab root. Expo Router 58's `navigate` pushes and `dismissTo` does not cross tabs. Use `navigation.navigate("<tab route>")` and then `router.dismissTo(href)`, as worked out in the SDK 58 upgrade.
- Threads: open `agents/[agentId]` or the thread route.
- Cold start: `getLastNotificationResponseAsync()` once the gateway client is ready, then `clearLastNotificationResponseAsync()`.
- Foreground: `setNotificationHandler` returns no banner, sound or badge when the notification targets the chat or thread on screen.
- Replace the "always `/(drawer)`" behaviour and its pinned test in `__tests__/push.test.ts`.
- Done when: a warm tap and a cold tap each open the exact target, on iOS and Android; a push naming another computer switches to it first; and a push without `handle` whose target is missing on the active computer opens the chat list. Evidence: Native Mobile.

**A2 · Push tokens survive restarts** (`packages/gateway/src/channels/push.ts`)
- Move token storage from the in-memory `Map` to an owner table `notification_push_tokens`. Keep the existing caps (16 per owner, 30-day TTL) as SQL: `ON CONFLICT (token) DO UPDATE`, and evict the oldest in the same transaction.
- The route contract (`POST/DELETE /api/push/register`) does not change.
- Add `handle` (the VPS's `MATRIX_HANDLE`) to the `data` of every push, so A1 can switch to the computer a push came from before A4's v1 payload exists.
- Done when: a token registered before a gateway restart still receives a push after it, and every push's `data` carries `handle`. Evidence: N/A (no UI change; reason recorded in the PR).

**A3 · One native build** (`apps/mobile/app.json`, EAS credentials)
- Android: create a Firebase project, set `android.googleServicesFile` (or an EAS file variable, OQ-9), upload the FCM V1 service-account key with `eas credentials`, and declare `POST_NOTIFICATIONS`.
- Create the channels at startup, before any token request: `replies` (default importance) and `attention` (high). Android 13+ only prompts once a channel exists.
- Add `expo-task-manager` and `enableBackgroundRemoteNotifications: true` in the `expo-notifications` plugin config. A8b needs them.
- iOS: add the Time Sensitive Notifications capability (`com.apple.developer.usernotifications.time-sensitive`). Confirm `aps-environment` is `production` in release builds.
- No JS behaviour change beyond channel creation.
- Done when: an internal Android build and a TestFlight build both receive a test push. Evidence: Native Mobile (iOS and Android).

**A4 · Approvals and questions from every chat** (new `packages/gateway/src/notifications/`)
- Router core: the `notification_events` and `notification_attempts` tables, the bounded queue, dedupe, and the transport interface. The first transport is `expo-direct`, which wraps today's push channel.
- Compose `router.onChatEvent` into `onCommittedEvent` (see Integration wiring). Route `run.activity` rows that contain `approval.requested`, `input.requested` or `interaction.requested`.
- Fold `coding-agents/attention-notifications.ts` in as a thread-store sink, so Codex, Pi and OpenCode runs inside canonical chats notify once and never twice. The legacy bridge only runs when the kill switch is off.
- Interim rule: wait 15 s, then push only if the approval or question is still pending.
- Use the existing `attentionPush` preferences until A7a.
- Done when: an approval in a Claude chat pushes once after 15 s, an approval answered within 15 s pushes nothing, and a Codex approval pushes once. Evidence: Native Mobile.

**A5 · Reading on the phone counts as read** (`apps/mobile/components/chat/*`)
- When a chat is on screen with the app in the foreground, call `PATCH /api/chats/:chatId/read-state` with `{ type: "mark_read", throughSeq, baseVersion }`. Follow spec 123: advance only through committed assistant messages delivered to the view, debounce to one call per 2 s, and never override a manual unread mark during the visit.
- Done when: reading on the phone clears the unread state shown on Electron and web. Evidence: Native Mobile plus one Electron Desktop capture of the cleared state.

**A6 · Replies and failures, only if still unread** (gateway)
- Route `run.completed` and `run.failed`.
- Add the durable scheduler (`phone_send_after`) and resolution from the read cursor (`chat_user_state.read_through_seq`), `approval.resolved`, `input.resolved`, terminal runs and expiry.
- Interim rule: wait `replyDelaySeconds` (default 60 s), then push only if still unread.
- Done when: a reply read on any surface within 60 s pushes nothing, an unread reply pushes once, and a gateway restart during the wait neither drops nor repeats the push. Evidence: Native Mobile.

**A7a · Notification preferences API** (gateway, `packages/contracts`): `NotificationPreferencesSchema`, `~/system/notifications.json`, `GET/PUT /api/notifications/preferences`, migration from `attentionPush`, and the legacy route kept as a projection. Evidence: N/A (API only).

**A7b · Notifications screen** (`apps/mobile/app/settings-detail/notifications.tsx`): reads and writes through the gateway client with no local copy. The existing "Push notifications" switch in App settings links to it. Evidence: Native Mobile.

**A8a · Resolve and dismiss events** (gateway): on resolution, send a silent `dismiss` push with the resolved ids, and include a `badge` count in every push. Delete the legacy coding-agent bridge and its kill-switch branch. Evidence: N/A.

**A8b · Clear and badge on the phone** (`apps/mobile/lib/notifications/`): a background task (`Notifications.registerTaskAsync`) handles `dismiss` with `dismissNotificationAsync`. On every foreground, reconcile `getPresentedNotificationsAsync()` against `GET /api/notifications?state=open` and call `setBadgeCountAsync`. Evidence: Native Mobile.

**B1 · Presence socket** (gateway): `WS /ws/notifications`, the presence registry, the `notification_devices` table, and frame schemas. The router reads presence only in B2. Evidence: N/A.

**B2 · Electron reports activity and shows banners**
- Electron main process: socket client, `powerMonitor` idle and lock reporting, `show`/`ack`/`resolve` handling, and click routing to the exact chat. `handleDeepLink` honours `matrixos://chat/<id>`.
- The legacy kernel trigger in `kernel-wiring.ts` moves behind the router.
- Gateway: router steps 1 and 2 (inline and banner with ack), plus the "away" skip of the grace.
- Done when: AC-1, AC-2 and AC-3 pass on Electron. Evidence: Electron Desktop plus Native Mobile (the phone stays quiet).

**B3 · Web reports activity and shows banners** (`shell/`): the `useNotificationClient` hook at the shell root, `notificationclick` in `shell/public/service-worker.js` (bump `VERSION`), the Electron embed marker, in-app cards when OS permission is missing, and the title badge. Evidence: Web Desktop, Web Canvas, Web Mobile.

**B4 · Notifications section on computers**: the same section in shell Settings and Electron Settings, through main-process IPC. Electron's `AgentWorkspacePanels` toggles move here, and the legacy preference route is removed. Evidence: Web Desktop, Web Canvas, Electron Desktop.

**B5 · The open phone app counts as active** (`apps/mobile`): connect the socket on `AppState` `active`, report `attended:true` and the chat on screen, show an in-app banner for `show`, and close the socket on `background`. Evidence: Native Mobile.

**C1–C5 · Platform relay migration**
- C1 adds `push_devices` and `/api/push/devices`.
- C2 makes the app register with the gateway and the platform.
- C3 adds the relay, receipts and rate windows.
- C4 switches the gateway with `MATRIX_NOTIFICATIONS_TRANSPORT=relay`, falling back to direct on a relay 5xx until C5.
- C5 enables Expo enhanced push security, removes the direct transport and the gateway token table, and stops gateway registration in the app.
- Each step is safe to stop at.

**C6 · Act from the notification**: an `approval` category with Approve (`isAuthenticationRequired: true`) and Deny (`isDestructive`), and a `question` category with a text Reply for single free-text prompts. Actions call the existing approval and input routes with the same Platform proof as the in-app card (628). `risk: "high"` approvals have no Approve action. Evidence: Native Mobile.

**C7 · Web Push for closed tabs**: VAPID keys on the platform, a `webpush` device kind, endpoint host allowlist, and a `push` handler in the service worker. Used only when the owner has no phone device or opts in. On iOS this requires a Home Screen install. Evidence: Web Desktop.

## Surfaces (end state)

| Surface | While in use | While away | Settings | First release |
| --- | --- | --- | --- | --- |
| Native Mobile | In-app banner (B5) | Expo push | Notifications screen | A1 |
| Electron Desktop | Native notification from the main process | Phone push | Notifications section | B2 |
| Web Desktop | Browser notification through the service worker | Phone push (C7: Web Push to closed tabs) | Notifications section | B3 |
| Web Canvas | Same client as Web Desktop, mounted at the shell root | Same as Web Desktop | Same section | B3 |
| Web Mobile | Same web client in a phone browser | No push unless installed to the Home Screen (C7) | Same section | B3 |

All surfaces read one preferences schema and one routing decision. Renderers do not duplicate routing or copy logic.

Out of scope:
- Legacy kernel `/ws` approvals. They auto-deny after 30 s, which is too short for a phone round trip.
- The cron, security, integration, app and voice categories from 027.
- Quiet hours (OS Focus and Do Not Disturb cover them), email, Telegram fallback, encrypted previews and Live Activities.
- Notifying anyone but the runtime owner.

## Behaviour

End state (after Track B):
1. **Watching the chat** (on screen in a visible, focused window): no notification. The chat updates live.
2. **At a computer:** a banner on the surface in use only. The phone stays quiet.
3. **Away** (3 min without input, or 1 min after the screen locks; OQ-1): approvals and questions go to the phone immediately. Replies and failures go after `replyDelaySeconds` if still unread.
4. **Nothing open:** approvals and questions go to the phone after the 15 s grace. Replies and failures go after `replyDelaySeconds` if still unread.
5. **Banner can't be shown:** blocked permission, or no ack within 5 s, falls through to the phone path.
6. **Answered or read elsewhere:** banners close, the phone notification is removed (best effort), and badges update.
7. **Back at the desk:** when a surface becomes in use, any open approval or question that reached no surface is shown there once.

Interim (Track A only, before presence):
- Approvals and questions push after 15 s if still pending.
- Replies and failures push after `replyDelaySeconds` (default 60 s) if still unread.
- No computer banners for canonical chats yet. Electron keeps its existing legacy kernel banners.
- An owner working in another app at their desk may get a phone push after the wait. Track B removes this case.

## Routing

The router evaluates each event once. The first matching step decides. The Release column shows when each step starts to run.

| Step | Condition | Outcome | Release |
| --- | --- | --- | --- |
| 0 | Kind off in preferences; a reply or failure in a muted chat (OQ-8); a reply shorter than `minReplySeconds`; or kill switch off | `suppressed` (badge only) | A4, A6 |
| 0b | Dedupe key already exists | Ignored | A4 |
| 1 | A fresh, attended presence record that is `visible` and `focused`, with `viewingChatId` equal to the event's chat. A hidden tab or an unfocused window does not count. | `inline` | B2 |
| 2 | One or more attended, enabled devices that can show the alert and have not been tried for this event | Send `show` to the most recently active one and wait up to 5 s for an ack. `displayed` or `inline` → `delivered`. `unavailable` or timeout → the next untried surface. At most 2 banner attempts per event in total, counted from `notification_attempts` across re-checks. | B2 |
| 3 | No surface took it, and `phone.mode != "never"` | Set `phone_send_after = now + wait`. Approvals and questions: 0 s if a fresh presence record says away (idle or locked), otherwise the fixed 15 s grace. Replies and failures: `replyDelaySeconds`. | A4, A6 |
| 4 | The scheduler finds a due event still unresolved | From B2, re-check from step 1: the owner is watching the chat now → `inline`; an attended device not yet tried, with banner attempts left → step 2. Otherwise claim it as `sending` and call the transport. Success → `pushed`. Failure → retry with backoff. A device that already failed for this event never delays the phone again. | A4, B2 |

- `phone.mode = "always"` runs step 2 and pushes immediately in parallel (fan-out as an opt-in).
- `phone.mode = "never"` stops after step 2. The event stays open for badges and the in-app attention lane.
- Only one surface shows a banner per event. Other attended surfaces get `badge` only.
- **Startup grace:** for 30 s after the gateway starts, presence is unknown, and replies and failures hold their phone send until it ends.

## Event sources and resolution

| Source | Notify on | Resolve on | Dedupe key |
| --- | --- | --- | --- |
| Canonical chat outbox (all harnesses, bots) | `run.activity` with `approval.requested` or `input.requested`, and `interaction.requested` (A4). `run.completed` and `run.failed` (A6). | Approval: `approval.resolved` or a terminal run. Question: `input.resolved` or a terminal run. Bot: `interaction.resolved`. Reply and failure: `read_through_seq` at or past the event's message seq. | `approval:<id>`, `input:<id>`, `interaction:<id>`, `run:<runId>:<outcome>` |
| Coding-agent thread store (A4) | Approval and input requests, `thread.completed`, `thread.error` | Matching decision, answer or terminal events | `thread:<threadId>:<kind>:<eventSeq>` |
| Any | n/a | A `clicked` frame, `POST /api/notifications/:id/opened`, or `expires_at` passing | n/a |

Rules:
- **Committed events only.** `run.activity` payloads carry `{runId, activityIds, removedActivityIds}`. The router loads at most 50 activity rows by id after commit, outside the writing transaction. Only live commits are routed; replay, reconnect and `Last-Event-ID` resume never reach the sink (523).
- **No double notify.** Codex, Pi and OpenCode runs inside canonical chats produce both canonical activities and thread events. The canonical event wins. The thread sink ignores threads bound to a canonical run, so each request notifies once.
- **Never notifies:** a manual "Mark as unread" (123), and `run.aborted` (Stop or shutdown).
- **Reply length** comes from `chat_runs.started_at`.
- **Expiry** uses each request's own `expiresAt`. Nothing is hardcoded: 628 approvals expire in 10 min, 633 questions in 30 min, Claude integrations in 5 min, Pi dialogs in at most 240 s, and bots in 24 h.

## Presence (Track B)

Each client computes `attended` locally with one shared pure helper in `packages/contracts`. It sends a `presence` frame on every change and every 25 s. A record is fresh for 60 s after the last frame. Clients send `idleMs` (relative), and the server stamps receipt time, so client clocks do not matter.

| Surface | Attended when | Signals |
| --- | --- | --- |
| Electron Desktop | The screen is unlocked and system input happened within `awayAfterSeconds`. Also up to 15 min without input while the window is focused on a chat with an active run. | `powerMonitor.getSystemIdleTime()` polled every 15 s; `lock-screen`, `unlock-screen`, `suspend`, `resume`; window focus |
| Web Desktop, Web Canvas, Web Mobile | Input in the tab within `awayAfterSeconds`, visible or hidden. Also up to 15 min for a visible, focused tab on a chat with an active run. | `visibilitychange`, focus and blur, pointer and key events throttled to 1 per 5 s, `Notification.permission` |
| Native Mobile | `AppState` is `active` | `AppState`. On `background` the app sends `attended:false` and closes the socket. |

- **Watching a chat:** `viewingChatId` names the chat on screen, or null. `visible` and `focused` describe the window or tab: Electron `BrowserWindow.isVisible()` and `isFocused()`, web `document.visibilityState` and `document.hasFocus()`, Native Mobile `AppState` `active`. Only a record that is attended, visible and focused counts as watching (routing step 1), the same rule spec 123 uses for marking read.
- **Blind spots:** web pages cannot see input in other apps, and no surface can see macOS Focus or OS Do Not Disturb. A banner hidden by Focus counts as `displayed`.
- **Embedded hosted shell:** Electron shows the Next.js shell in a WebContentsView on the Home tab. That embed must not start the web client. Electron loads it with an `embed=electron` marker that the shell reads once at boot. Without this, Electron would show two banners.

## Settings and defaults

`NotificationPreferencesSchema` lives in `packages/contracts/src/notifications.ts` and is stored at `~/system/notifications.json` with an atomic write (temp file, then rename). Updates replace the whole document after validation. One in-process mutex serializes read-modify-write. Each `PUT` carries the `revision` it was based on, and a mismatch returns a generic 409 so the client reloads.

```ts
export const NotificationPreferencesSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0),
  events: z.object({
    approval: z.boolean(),            // default true
    question: z.boolean(),            // default true
    replyFinished: z.boolean(),       // default true (OQ-2)
    runFailed: z.boolean(),           // default true
    minReplySeconds: z.union([z.literal(0), z.literal(10), z.literal(30), z.literal(60), z.literal(300)]), // default 10
  }).strict(),
  phone: z.object({
    mode: z.enum(["when_away", "always", "never"]),                                                     // default "when_away"
    awayAfterSeconds: z.union([z.literal(60), z.literal(180), z.literal(300), z.literal(600), z.literal(900)]), // default 180 (OQ-1); used from B2
    replyDelaySeconds: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(120), z.literal(300)]),   // default 60 (OQ-10)
  }).strict(),
  content: z.object({
    showPreview: z.boolean(),         // default true (OQ-3)
    sound: z.boolean(),               // default true
  }).strict(),
}).strict();
```

- The 15 s attention grace and the 60 s lock rule are fixed constants in v1, not settings.
- **Missing file:** use the defaults. **Corrupt or unreadable file:** fail closed for push and log on the server, as the attention preferences do today.
- **Migration (A7a):** the first read seeds `events.*` from `~/system/coding-agents/notification-preferences/<owner>.json`. The legacy `GET/PUT /api/coding-agents/notification-preferences` route stays as a projection until B4.
- **Before A7a,** the router uses `attentionPush` for kinds and the defaults above for everything else.
- **Native Mobile** reads and writes through the gateway client and keeps no local copy. Per `docs/dev/coding-agent-shells.md`, it never uses AsyncStorage for these preferences.
- **Electron Desktop** uses main-process IPC (`notifications:get-preferences`, `notifications:update-preferences`) validated in `desktop/src/shared/ipc-contract.ts`. The renderer never holds the bearer.
- **Devices (B1)** live in the owner table `notification_devices`, not this file. `PATCH /api/notifications/devices/:deviceId` changes `enabled` or `label`.
- **Settings UI:**
  - Notify me when: four toggles, plus the reply-length select.
  - Phone: mode, away-after (from B2), and "Send replies if still unread after".
  - Content: preview and sound.
  - Your devices (from B4): per-device toggle, permission state, and "Send a test notification".

## Protocol: `WS /ws/notifications` (B1)

A dedicated socket. Chat events stay on the existing SSE and WS streams. Frames are JSON of at most 4 KiB, validated with Zod after parsing. Each socket may send at most 10 frames per second; beyond that it is closed with code 1008.

```ts
const DeviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const NotificationIdSchema = z.uuid();

export const NotificationClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), surface: z.enum(["electron", "web", "mobile"]), deviceId: DeviceIdSchema,
             appVersion: z.string().max(40), permission: z.enum(["granted", "denied", "default"]) }).strict(),
  z.object({ type: z.literal("presence"), attended: z.boolean(), idleMs: z.number().int().min(0).max(86_400_000),
             visible: z.boolean(), focused: z.boolean(), locked: z.boolean().optional(), viewingChatId: ChatIdSchema.nullable(),
             runActiveInView: z.boolean() }).strict(),
  z.object({ type: z.literal("ack"), id: NotificationIdSchema, outcome: z.enum(["displayed", "inline", "unavailable"]) }).strict(),
  z.object({ type: z.literal("clicked"), id: NotificationIdSchema }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);

export const NotificationServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("show"), notification: NotificationViewSchema }).strict(),
  z.object({ type: z.literal("resolve"), ids: z.array(NotificationIdSchema).max(50) }).strict(),
  z.object({ type: z.literal("badge"), count: z.number().int().min(0).max(9_999) }).strict(),
  z.object({ type: z.literal("pong") }).strict(),
  z.object({ type: z.literal("closing") }).strict(),
]);

export const NotificationViewSchema = z.object({
  id: NotificationIdSchema,
  kind: z.enum(["reply_finished", "run_failed", "approval", "question"]),
  title: z.string().max(80),
  body: z.string().max(180).optional(),
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("chat"), chatId: ChatIdSchema }),
    z.object({ type: z.literal("thread"), threadId: ThreadIdSchema }),
  ]),
  urgency: z.enum(["normal", "high"]),
  expiresAt: z.iso.datetime().optional(),
}).strict();
```

- **Auth:** browsers use the query token from `/api/auth/ws-token`, and the path is added to `WS_QUERY_TOKEN_PATHS`. Electron's main process and Native Mobile send `Authorization: Bearer`. The owner comes only from the verified principal, and a non-owner principal is refused at upgrade.
- **Handshake:** the first frame must be `hello`, within 5 s. The gateway awaits the device upsert before sending `ready`. Any other first frame, or a timeout, closes the socket.
- **Per-connection state:** each socket's state is allocated in the upgrade handler, never in a shared closure. A second socket with the same `deviceId` replaces the older one, which receives `closing`.
- **Sending:** `show` targets one socket. `resolve` and `badge` go to every socket of the owner. Each send is isolated, and a socket whose send fails is evicted after the loop.
- **Copy:** built only from safe fields: the chat title, the first 180 characters of committed assistant text with markdown stripped, the approval `title` or `safeDescription`, and the input `title`. Tool arguments, file paths and provider errors are never included. With `showPreview: false`, the title is "Matrix OS" and the body is generic ("Your agent finished a reply").
- **Closing banners:** Electron keeps `Notification` objects in a Map capped at 50 so `resolve` can call `.close()`. The web client uses `tag = id` and closes through `registration.getNotifications({tag})`.
- **No OS permission on web:** a visible, focused tab shows an in-app card through `ShellNotificationPortal` and acks `displayed`. Otherwise it acks `unavailable`.
- **Navigation:** payloads carry target ids, never URLs. Click handlers build a same-origin route from a validated target.

## Phone payload

| Field | Value | From |
| --- | --- | --- |
| `title`, `body` | Same safe copy as `show` | A4 |
| `data` | `{ v: 1, notificationId, handle, target }` only, under 1 KiB | A4 (A1 also accepts the old shape) |
| `channelId` (Android) | `replies` or `attention` | A4, needs A3 |
| `interruptionLevel` (iOS) | `time-sensitive` for approvals and questions, `active` otherwise | A4, needs A3 |
| `collapseId` | The chat or thread id for replies; the event id for approvals and questions | A4 |
| `ttl` | Seconds until `expires_at`, or 24 h for replies | A4 |
| `badge` | Unread canonical chat count (the Dock badge rule; OQ-7) | A8a |
| `categoryId` | `reply`, `approval` or `question` | C6 |

## Persistence

**Owner Postgres** (customer VPS, Kysely, versioned bootstrap like the chat and bot schemas). Each table arrives with the release that first needs it.

```sql
-- A2; dropped in C5
CREATE TABLE IF NOT EXISTS notification_push_tokens (
  token        text PRIMARY KEY CHECK (char_length(token) <= 512),
  owner_id     text NOT NULL,
  platform     text NOT NULL CHECK (char_length(platform) <= 32),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- A4
CREATE TABLE IF NOT EXISTS notification_events (
  id               uuid PRIMARY KEY,
  owner_id         text NOT NULL,
  dedupe_key       text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('reply_finished','run_failed','approval','question')),
  source           text NOT NULL CHECK (source IN ('canonical_chat','coding_agent','bot')),
  chat_id          text, run_id text, thread_id text, message_seq bigint,
  title            text NOT NULL CHECK (char_length(title) <= 80),
  preview          text CHECK (char_length(preview) <= 180),
  urgency          text NOT NULL CHECK (urgency IN ('normal','high')),
  state            text NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open','inline','delivered','sending','pushed','resolved','expired','suppressed','failed')),
  delivered_device text,
  phone_send_after timestamptz,
  evaluated_at     timestamptz,                  -- set when the router has run the ladder for this row
  claimed_at       timestamptz,
  push_attempts    smallint NOT NULL DEFAULT 0,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  UNIQUE (owner_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notification_events_unevaluated
  ON notification_events (created_at) WHERE state = 'open' AND evaluated_at IS NULL;
CREATE INDEX IF NOT EXISTS notification_events_due
  ON notification_events (phone_send_after) WHERE state IN ('open','delivered') AND phone_send_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_events_open_chat
  ON notification_events (owner_id, chat_id) WHERE state IN ('open','delivered','pushed','inline');

CREATE TABLE IF NOT EXISTS notification_attempts (
  id         uuid PRIMARY KEY,
  event_id   uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  channel    text NOT NULL CHECK (channel IN ('electron','web','mobile_live','expo_push','web_push')),
  device_id  text,
  outcome    text NOT NULL CHECK (outcome IN ('displayed','inline','unavailable','timeout','sent','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- B1
CREATE TABLE IF NOT EXISTS notification_devices (
  device_id    text PRIMARY KEY CHECK (device_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  owner_id     text NOT NULL,
  surface      text NOT NULL CHECK (surface IN ('electron','web','mobile')),
  label        text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  enabled      boolean NOT NULL DEFAULT true,
  permission   text NOT NULL CHECK (permission IN ('granted','denied','default')),
  app_version  text,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
```

- **Inserts:** an event insert is `ON CONFLICT (owner_id, dedupe_key) DO NOTHING RETURNING id`. The event and its first attempt are written in one transaction.
- **State changes:** every change is one conditional `UPDATE … WHERE id = :id AND state = :expected`. Resolution uses `WHERE state IN ('open','delivered','sending','pushed','inline')`. A send that completes after its row was resolved matches nothing, and the router sends `dismiss` (from A8a).
- **Scheduler claim:** one transaction with `SET LOCAL statement_timeout = '5s'` selects `WHERE state IN ('open','delivered') AND phone_send_after <= now() ORDER BY phone_send_after LIMIT 50 FOR UPDATE SKIP LOCKED`, sets `sending` and `claimed_at = now()`, and commits.
- **Push outcome:** the transport call runs after commit, never inside the transaction. Success sets `pushed`. A retryable failure returns the row to `open` with `push_attempts + 1` and a backed-off `phone_send_after`. After 3 attempts, or once past `expires_at`, it becomes `failed`.
- **Reclaim:** a `sending` row with `claimed_at` older than 60 s is reclaimed by the next tick. With the direct transport, a crash mid-send can repeat one push. From C4, the relay's `UNIQUE (event_id, device_id)` makes the repeat a no-op.
- **Devices (B1):** `hello` upserts with `ON CONFLICT (device_id) DO UPDATE SET permission, app_version, last_seen_at` and never overwrites `enabled` or `label`. At most 32 devices per owner: a new device beyond that deletes the least recently seen one in the same transaction.

**Platform Postgres** (C1, C3):

```sql
-- C1
CREATE TABLE push_devices (
  id            uuid PRIMARY KEY,
  clerk_user_id text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('expo','webpush')),
  token         text NOT NULL,
  p256dh        text, auth text,
  platform      text NOT NULL, label text NOT NULL, app_version text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,
  UNIQUE (kind, token)
);
CREATE INDEX push_devices_user ON push_devices (clerk_user_id) WHERE disabled_at IS NULL;

-- C3
CREATE TABLE push_sends (
  id            uuid PRIMARY KEY,
  clerk_user_id text NOT NULL,
  handle        text NOT NULL,
  event_id      uuid NOT NULL,
  device_id     uuid NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  ticket_id     text,
  status        text NOT NULL CHECK (status IN ('queued','accepted','error','receipt_ok','receipt_error')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, device_id)
);

CREATE TABLE push_rate_windows (
  scope        text NOT NULL,              -- 'push:<handle>', 'dismiss:<handle>', 'register:<clerkUserId>'
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (scope, window_start)
);
```

- **Rate limits:** each limit is one statement: `INSERT … ON CONFLICT (scope, window_start) DO UPDATE SET count = push_rate_windows.count + 1 RETURNING count`. Over the limit returns a generic 429. There are no in-memory counters, so several platform instances cannot each allow the full limit.
- **Registration:** `INSERT … ON CONFLICT (kind, token) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id, last_seen_at = now(), disabled_at = NULL`. The last signed-in registrant owns a token, and the app re-registers on every foreground.
- Device tokens never appear in any API response.
- **Deletion:** the platform account-deletion path deletes the user's `push_devices` (`push_sends` cascade). Sign-out deletes that device. Owner tables follow the owner database's export and deletion policy.

## Security architecture

### Auth matrix

There are no inbound webhooks. Expo receipts are polled.

| Endpoint | Release | Caller | Auth | Validation and limits |
| --- | --- | --- | --- | --- |
| `POST/DELETE /api/push/register` | existing; persisted in A2; removed in C5 | Native Mobile | Owner principal | Existing Zod schema; `bodyLimit` 4 KiB (add it to DELETE if missing) |
| `PATCH /api/chats/:chatId/read-state` | existing; used by mobile from A5 | Native Mobile | Owner principal | Existing |
| `GET /api/notifications` | A8a | Owner clients | Owner principal | Zod query: `state` ∈ {open}, `limit` 1–100, opaque cursor ≤ 200 chars |
| `POST /api/notifications/:id/opened` | A8a | Native Mobile cold start | Owner principal | `bodyLimit` 1 KiB, uuid param, owner-scoped update |
| `GET/PUT /api/notifications/preferences` | A7a | Owner clients | Owner principal | `bodyLimit` 16 KiB, strict full-replace schema with base `revision`, 409 on mismatch |
| `GET/PUT /api/coding-agents/notification-preferences` | existing; projection from A7a; removed in B4 | Electron | Unchanged | Unchanged |
| `WS /ws/notifications` | B1 | Shell, Electron main, Native Mobile | Owner principal; query token allowed for browsers | Frame schemas, 4 KiB, 10 frames/s, 64 sockets per owner (oldest evicted) |
| `GET /api/notifications/devices`, `PATCH /api/notifications/devices/:deviceId` | B1 | Settings | Owner principal | `bodyLimit` 1 KiB; device id regex; strict `{ enabled?, label? }` |
| `POST /api/notifications/test` | B4 | Settings | Owner principal | `bodyLimit` 1 KiB; 3 per minute per owner; returns `{ delivered, channel }` only |
| `POST/GET/DELETE /api/push/devices` (platform) | C1 | Native Mobile; C7 browsers | Clerk session | `bodyLimit` 4 KiB (1 KiB on DELETE); Expo token regex `^ExponentPushToken\[[A-Za-z0-9_-]{16,64}\]$`; 16 active devices per user; 30 registrations per hour |
| `POST /internal/containers/:handle/notifications/push` and `/dismiss` (platform) | C3 | VPS gateway | Bearer `HMAC(platformSecret, handle)` through the existing internal guard | `SAFE_SLUG` handle; strict body; 60 pushes per hour and 10 per minute per handle; `eventIds` ≤ 50; returns `202 {accepted}` |
| Expo Push API (outbound) | A2 direct from the VPS; C4 from the platform | Gateway, then platform | None until C5; `EXPO_ACCESS_TOKEN` from C5 | `AbortSignal.timeout(10_000)`, chunks of 100, receipts ≤ 1,000 per call |

- **Relay body (strict):** `{ eventId: uuid, kind, title ≤ 80, body? ≤ 180, target, collapseKey ≤ 64, urgency, badge 0–9999, expiresAt }`.
- **Relay auth:** the bearer is checked with the existing `timingSafeEqual` comparison in `platform-token.ts`. The platform maps the handle to its owner through the machine record and ignores any device, token or identity header in the request, including `x-platform-user-id`. A VPS reaches only its own owner's devices.
- **Before C5:** sends to Expo carry no access token. Anyone holding a device's Expo token could push to it. Tokens are stored only on the owner's VPS and are never returned by an API. Track C closes this gap.

### Input validation

- **Route boundary:** every path and query parameter is parsed with Zod. Bodies use `bodyLimit` before parsing, including DELETE.
- **Frames:** size-checked, JSON-parsed, then schema-checked. An unknown type closes the socket.
- **Ids:** chat and thread ids from clients are used only as lookup keys within the owner's scope.
- **Identity:** no security decision reads `Host`, `X-Forwarded-*` or client-supplied identity headers.
- **Copy:** clamped on the server, with control characters stripped. Every surface renders it as plain text.
- **Taps and actions:** notification taps validate the payload before navigation (105 FR-065). An invalid payload opens the chat list.

### Error policy

- **Clients:** get generic errors through the existing route mapper.
- **Server logs:** Expo, relay, database and filesystem errors are logged on the server with the bounded redacted diagnostics helper and never echoed.
- **Coarse results:** `test` returns only a coarse boolean and channel, and the relay returns only `{accepted}` or a generic 4xx/5xx.

### Credentials

- **Platform secrets:** `EXPO_ACCESS_TOKEN` (C5) and the VAPID private key (C7) live only in the platform secret manager. They never reach a customer VPS, a log or a response.
- **VPS credentials:** customer VPSes use their existing `UPGRADE_TOKEN`, `PLATFORM_INTERNAL_URL` and `MATRIX_HANDLE`.
- **Firebase:** the config is a client identifier, not a secret. The FCM V1 service-account key stays in EAS credentials only.

### Third-party data flow

| Recipient | Data | When |
| --- | --- | --- |
| Expo, then Apple or Google | Title, body, and `data` (`notificationId`, `handle`, target id) | Phone pushes (`handle` from A2, the v1 payload from A4) |
| Browser push services | Ciphertext only, plus endpoint metadata | C7 |
| OS notification centres | Title and body | Local banners (B2 on) |
| PostHog | Counts only: `notification_routed {kind, outcome, channel}`, with no content or ids | A4 on |

With `showPreview: false`, no chat content leaves the VPS.

## Integration wiring

### Gateway

New directory `packages/gateway/src/notifications/`: `router.ts`, `scheduler.ts`, `repository.ts`, `copy.ts`, `preferences-store.ts` (A7a), `presence-registry.ts` and `ws-route.ts` (B1), `routes.ts`, and `transports/{expo-direct,platform-relay}.ts`. `server.ts` only wires them.

Startup order:
1. Once the owner database is ready, run the notifications schema bootstrap.
2. Resolve the transport. A4 uses `expo-direct`, which wraps the existing push channel. From C4, `MATRIX_NOTIFICATIONS_TRANSPORT=relay` with `PLATFORM_INTERNAL_URL` set selects the relay. An unresolved transport fails startup rather than failing at call time.
3. Create `NotificationRouter({ db, preferences, presence, transport, clock, logger })`. Before B1, `presence` is a null registry that always reports "unknown". Record `startedAt` for the 30 s grace.
4. In `createGatewayChatEventStream` (`chat/gateway-event-stream.ts`), pass `onCommittedEvent: composeSinks(createChatFailureRecorder(options), router.onChatEvent)`. `ChatOutboxDelivery` allows one sink, so compose the functions rather than register a second sink. `composeSinks` calls each sink in its own try/catch and logs failures, so a router error never breaks telemetry or chat delivery. The router sink is synchronous and only enqueues.
5. Register `router.onThreadEvent` with the thread store's `registerEventSink`. When the kill switch is on (router off), register the legacy attention bridge instead. This branch is removed in A8a.
6. Mount routes as each release adds them. Start the scheduler (2 s tick) and the hourly retention sweep.

Shutdown:
1. Stop the scheduler and sweep timers.
2. Stop accepting router work and give the queue up to 2 s to drain.
3. Send `closing` to sockets and close them.
4. Clear the presence registry and ack waiters.
5. The router does not own the database pool, so it does not close it. Guard flags make late events or acks no-ops.

### Platform (C1, C3)

- `registerPushDeviceRoutes(app, { db, clerk })` mounts behind the existing Clerk session middleware.
- `registerNotificationRelayRoutes(app, { db, expo, guard })` mounts next to the existing `/internal/containers/:handle/*` routes in `packages/platform/src/main.ts`.
- `new ExpoPushClient({ accessToken?, timeoutMs: 10_000 })`. From C5 a missing token disables the relay with a generic 503, and it never falls back to sending without one.
- `startPushReceiptJob({ intervalMs: 5 * 60_000 })` checks receipts for sends older than 15 min, disables dead devices, and prunes old rows. It is cleared on platform shutdown and guarded by a stop flag.

### Clients

- **Native Mobile:** `lib/notifications/` holds the payload parser and tap routing (A1), read marking (A5), the background dismiss task (A8b), the socket client (B5) and platform registration (C2). Listeners start with the active computer's `GatewayClient` in `app/_layout.tsx` and are keyed per computer. Sign-out unregisters the device (gateway, plus the platform from C2) before tokens are cleared, and removes listeners and the background task.
- **Electron Desktop (B2):** the main process creates the client once auth is ready, keyed by runtime slot and auth generation. A runtime switch, sign-out or quit closes the socket, clears the `powerMonitor` poll and the notification Map, and drops late frames by generation check. The renderer talks to it through validated IPC: `notification:clicked` is widened to `{ target }`, a new `notifications:*` invoke channel is added, and the existing `badge:set` is reused.
- **Web (B3):** `useNotificationClient` mounts once inside the authenticated shell provider tree, above the Desktop, Canvas and Mobile presentation switch, so changing presentation never reconnects it. It is skipped in the Electron embed. The permission prompt is only requested from a click.
- **No shared globals:** no `globalThis`; dependency injection only. The kernel and IPC tools are not involved.

### Config

| Setting | Source | Consumer | Release |
| --- | --- | --- | --- |
| `MATRIX_NOTIFICATIONS_ROUTER` (`on`/`off`, default `on`) | `host.env` | Router kill switch | A4 to A8a |
| `MATRIX_NOTIFICATIONS_TRANSPORT` (`direct`/`relay`) | `host.env`, shipped default | Transport selection | C4 |
| `PLATFORM_INTERNAL_URL`, `UPGRADE_TOKEN`, `MATRIX_HANDLE` | `host.env` (existing) | Relay transport | C4 |
| `EXPO_ACCESS_TOKEN` | Platform secret manager | Relay | C5 |
| `WEB_PUSH_VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` | Platform secret manager; public key served to the shell | Relay, shell | C7 |
| Firebase `google-services.json` | Repo or EAS file variable (OQ-9) | Android FCM | A3 |

## Failure modes

| Case | Handling |
| --- | --- |
| Expo or relay slow or failing | `AbortSignal.timeout(10_000)`. Retry 3 times with 2 s, 8 s and 30 s backoff while before `expires_at`, then `failed`. Logged; the owner sees no error. |
| Gateway restart during a wait | The scheduler resumes from `phone_send_after`. `open` events never evaluated (`evaluated_at IS NULL`) and older than 15 s run the ladder once, through the scheduler's per-tick pickup. The dedupe key prevents a second event. |
| Crash between commit and enqueue | Accepted loss: that one event does not notify. No duplicate is possible. |
| Router queue full (> 1,000 pending) | The newest reply and failure events are dropped, with a counter and a log. An approval or question evicts the oldest queued reply. If no queued reply is left to evict, it is written straight to `notification_events` as `open` with the generic copy for its kind (as with `showPreview: false`) and `ON CONFLICT (owner_id, dedupe_key) DO NOTHING`, instead of being queued. The scheduler's per-tick pickup then runs the ladder for it. Memory stays capped at 1,000 items, and no approval or question is dropped. |
| Concurrent resolve and push | Conditional updates. A push for a resolved row is skipped, and a resolve after a push triggers `dismiss`. |
| Two gateway processes overlap during a restart | `FOR UPDATE SKIP LOCKED` plus conditional updates |
| Interim false push (Track A) | The owner is at their desk in another app and does not read within the wait. Accepted until B2. Owners can raise `replyDelaySeconds` or turn replies off. |
| Mobile read marking fails (A5) | The read cursor does not advance, so a reply may still push. The failure is logged and retried on the next view. |
| Ack never arrives (B2+) | `timeout` after 5 s, then the next surface or the phone. A rare double alert is cleaned up by `resolve`. |
| Half-open socket (laptop lid closed) | Electron reports on `suspend` as a best effort. Otherwise the 60 s staleness drops the record. |
| Preferences file corrupt | Fail closed for push and log. Settings shows a "couldn't load" notice and blocks saving until a reload succeeds. |
| Two Settings windows save at once | The second `PUT` gets a 409 on the stale `revision`, and the client reloads. |
| Approval expires unseen | The event becomes `expired`, and `resolve`/`dismiss` go out. The chat shows its existing expired state. |
| `DeviceNotRegistered` | Before C4, the gateway deletes the token on the push ticket error. From C4, the platform disables the device from tickets or receipts. |
| Burst of finished replies | `collapseId` per chat replaces earlier copies. Past 3 pushes per owner in 60 s, the router sends one summary ("3 replies finished") and suppresses the rest of that minute. |
| Phone signed in to another computer | From A2 the payload carries `handle`, and the tap switches computers first (A1). A push without it opens the target on the active computer, or the chat list if it isn't there. |
| Notifications blocked on a device | Mobile: no token, so no push. Computers (B2+): `hello` reports `denied`, the router skips the device, and Settings explains how to allow it. |
| Unsigned Electron dev build after an upgrade to Electron 42 | macOS emits `failed`. The client acks `unavailable`, and the alert falls through to the phone. Documented in the desktop dev notes. |
| Platform down (C4+) | Retries, then a direct send until C5. After C5 the phone step fails after retries. Computers are unaffected. |
| Kill switch flipped mid-wait | Pending rows stay. The scheduler skips them while the router is off and resumes when it comes back on. Expired rows are swept. |

## Resource management

| Resource | Limit and eviction | Release |
| --- | --- | --- |
| Router queue | 1,000 items with priority eviction. Approvals and questions that do not fit go to the owner table, not memory. One worker, at most 4 concurrent evaluations. | A4 |
| Scheduler | 50 due events per tick, a tick every 2 s, at most 3 push attempts per event. Each tick also picks up at most 50 never-evaluated `open` rows older than 15 s and runs the ladder for them once. | A4 |
| Owner tables | Hourly sweep deletes events and attempts older than 30 days, tokens unseen for 30 days, and devices unseen for 90 days | A2, A4, B1 |
| Mobile read marking | One in-flight request per chat, debounced 2 s | A5 |
| Presence registry | 64 sockets per owner (oldest evicted); a 30 s sweep removes records stale for over 60 s; cleared on shutdown | B1 |
| Ack waiters | One per in-flight `show`, at most 64, each with a 5 s timer cleared on every terminal path | B2 |
| Electron | Notification Map capped at 50; one `powerMonitor` poll (15 s) and one heartbeat (25 s), cleared on close, sign-out, runtime switch and quit | B2 |
| Web client | In-memory throttles only; all listeners and timers removed on unmount | B3 |
| Platform tables | `push_sends` kept 7 days; rate windows 2 h; devices disabled for 30 days are deleted; devices unseen for 120 days are disabled | C1, C3 |
| Copy and frames | Title ≤ 80, body ≤ 180, `data` < 1 KiB, push < 4 KiB, frames ≤ 4 KiB, 10 frames/s, 5 s `hello` deadline | A4, B1 |

No temp files are created. Every timer is cleared on its terminal paths and on shutdown.

## Acceptance checks

| ID | Check | Release |
| --- | --- | --- |
| AC-1 | Owner active in Electron and working in another app → reply banner on Electron within 2 s of commit (094 target), and no phone push | B2 |
| AC-2 | Owner viewing the chat in a focused window → no banner and no push. The event is `inline`. | B2 |
| AC-3 | Electron idle past `awayAfterSeconds`, or locked for 60 s → an approval pushes within 5 s of commit | B2 |
| AC-4 | Web notifications denied while the tab is hidden → `unavailable`, then the phone push | B3 |
| AC-5 | Approving on a computer after the phone buzzed → the phone notification is removed or reconciled on next foreground, and badges update | A8b |
| AC-6 | Two attended surfaces → exactly one banner, on the most recently active one | B3 |
| AC-7 | Replay, reconnect and gateway restart never produce a second notification for the same dedupe key | A4, A6 |
| AC-8 | A warm or cold tap opens the exact chat or thread on the right computer | A1 |
| AC-9 | The Electron Home-tab hosted shell never shows its own banner | B3 |
| AC-10 | With `showPreview: false`, push payloads contain no chat title or text | A7a |
| AC-11 | A VPS relay call can never reach another owner's devices (forged ids and tokens in the body) | C3 |
| AC-12 | Settings shows the same options, values and errors on every surface | B4 |
| AC-13 | Interim: an approval answered within 15 s, or a reply read within 60 s on any surface, never pushes | A4, A6 |
| AC-14 | A Codex approval inside a canonical chat pushes exactly once | A4 |
| AC-15 | Android receives pushes on the `attention` and `replies` channels | A3, A4 |

### Tests per release

- **Every release:** `bun run test`, `bun run typecheck` and `bun run check:patterns`. React releases also run react-doctor on the touched project. Mobile releases also run the mobile Jest (`--maxWorkers=4`, and the run must exit without `--forceExit`) and `tsc` gates.
- **A4 and A6 integration test:** start the real wiring (event stream with composed sinks, router, scheduler, fake transport) against a test owner database.
  - Commit `approval.requested`: one transport call after 15 s.
  - Commit `approval.resolved` first: no call.
  - Kill the scheduler between claim and send: the reclaim produces exactly one call.
  - Throw inside the router: failure telemetry still records `run.failed`.
  - Fill the router queue with 1,000 approvals, then commit one more: it is stored, not dropped, and the per-tick pickup pushes it exactly once.
- **B2 integration test:** a fake attended Electron socket receives one `show`, acks, and the transport is not called. With no ack, the transport is called once after 5 s.
  - A socket that acks `unavailable` and stays attended is not tried again at the due re-check: the transport is called once.
  - A chat selected in a hidden tab (`visible: false`) does not count as watching: the event goes to the banner step.
- **C3 and C4 integration test:**
  - Router → relay (platform test server with a fake Expo) → one message.
  - A repeated `eventId` is a no-op.
  - Two relay instances on one database cannot exceed the per-handle limit together.
  - Forged identity headers reach no other owner.
- **Manual checks:** run on a preview VPS (`docs/dev/preview-environments.md`) and on real devices, not Docker.

## Reconciliation with existing specs and docs

- **027-expo-app:** this spec supersedes the planned `/api/settings/notifications` and `config.json notifications.mobile.*` store. Other categories stay deferred. Quiet hours are dropped in favour of OS Focus.
- **094-electron-macos-shell:** FR-035 (notify when unfocused, deep link, coalescing) is met by B2's ladder. The 2 s target is kept. The legacy kernel trigger moves behind the router in B2.
- **105-coding-agent-shells and `docs/dev/coding-agent-shells.md` (Attention Notifications):**
  - Notifications stay gateway-owned, and the payload-safety and fail-closed preference rules are kept.
  - Delivery stops being "cross-device by policy" and becomes delayed-if-unseen (A4), then presence-routed (B2). `phone.mode = "always"` keeps fan-out as an option.
  - The doc's section is updated in A4.
- **123-chat-unread:** read state in `chat_user_state` stays the only authority. A5 brings Native Mobile under its rules. Manual unread marks never notify.
- **523-chat-background-runtime:** only live commits are routed, and stable request identities give stable dedupe keys.
- **`chat-dock-badge.md`:** the phone badge uses the Dock badge rule (OQ-7).
- **628-supervised-tool-approval:** "Needs you" stays the one attention lane. C6 actions use the same Platform proof.
- **633-agent-waiting-policy:** the router reads each request's own `expiresAt`, so 633's TTLs apply automatically.

## Open questions

| # | Question | Proposal |
| --- | --- | --- |
| OQ-1 | When does the owner count as away? | 3 min with no input, or 1 min after lock (Slack: 10 min and 1 min). Applies from B2. |
| OQ-2 | Do finished replies reach the phone by default? | Yes, for replies longer than 10 s and still unread after the wait. Approvals and questions always. |
| OQ-3 | Are lock-screen previews on by default? | On, with a switch. Encrypted previews later. |
| OQ-4 | May the platform store device push tokens? | Yes. Track C needs it to keep the Expo key off customer VPSes. |
| OQ-5 | Is Web Push for closed tabs needed? | Optional (C7). Skipping it saves about a week. |
| OQ-6 | Should the A4 and A6 interim waits be 15 s and 60 s? | Yes. Shorter waits push owners who are reading at their desk. Longer waits make the phone feel late. |
| OQ-7 | Should pending approvals and questions count toward the Dock and phone badges? | No, to keep `chat-dock-badge.md` parity. Revisit with design. |
| OQ-8 | Do approvals and questions in muted chats still notify? | Yes, because the run is blocked on the owner. Replies and failures stay muted. |
| OQ-9 | Is `google-services.json` committed or provided as an EAS file variable? | Decide in A3. |
| OQ-10 | Should the default reply wait stay 60 s after Track B? | Yes. It costs little for replies and covers the web blind spot. Owners can choose 0. |

## Risks

- **The interim rule pushes owners at their desk.** Track A's "unread after a wait" pushes owners who are at their desk but in another app. B2 removes this for Electron and B3 for web. Until then, the reply wait setting softens it.
- **Mobile read marking is new.** If A5 marks too eagerly (for example, while the app is backgrounded with the chat on screen), owners lose unread state. A5 must follow spec 123's focused-and-visible rule.
- **Tokens without an access token (until C5).** Anyone holding a device's Expo token could push to it. Tokens are only on the owner's VPS and never returned by an API.
- **Phone dismissal is best effort.** iOS throttles silent pushes, so foreground reconciliation is the backstop.
- **Web presence is tab-only.** Chromium's IdleDetector could narrow this later, at the cost of a permission prompt.
- **Gateway file size.** New behaviour lives in `notifications/`, with only wiring in `server.ts` and the chat files.

## Process

- Native Mobile releases (A1, A3, A5, A7b, A8b, B5, C2) are in the requester's area. Gateway, platform, web shell and Electron releases need those owners to agree, or the requester's explicit go-ahead to take them on.
- Suggest review by the chat and harness owners (router and sinks), the Electron Desktop owner, the platform owner (relay, secrets, deploy) and design (Settings copy and parity).
- Every user-visible PR includes the surface matrix and live captures for the surfaces named in its release above. Other surfaces get `N/A` with the reason "not touched by this release". Slack `#tech` posts are waived for the requester's PRs.
- Owner-facing documentation goes in a separate `FinnaAI/matrix-os-site` PR under `content/docs/`, once A6 ships. Done when that PR is merged and linked from this spec, and updated again when B4 brings the settings to computers.
