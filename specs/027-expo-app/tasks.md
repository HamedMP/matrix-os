# Tasks: Expo Mobile App

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T870-T899

## User Stories

- **US39**: "I can chat with my Matrix OS agent from my phone"
- **US40**: "I can manage tasks and see my dashboard on mobile"
- **US41**: "I get push notifications when my agent completes something important"
- **US42**: "The app looks and feels like Matrix OS -- same warmth, same design"
- **US43**: "I can connect to my local or cloud gateway securely"

---

## Phase A: Project Setup (T870-T874)

### T870 [US42] Expo project scaffold
- [x] Create `apps/mobile/` with `npx create-expo-app@latest --template tabs`
- [x] TypeScript strict mode (`tsconfig.json` strict: true)
- [x] Expo Router v4 with file-based routing
- [x] NativeWind v5 + Tailwind CSS v4 setup
- [x] ESLint + Prettier matching project conventions
- **Output**: Clean Expo project that builds and runs

### T871 [US42] Design system -- theme + fonts
- [x] Create `apps/mobile/lib/theme.ts` -- all design tokens from specs/design-guide.md
- [x] Colors: background (#ece5f0), card (#ffffff), primary (#c2703a), border (#d8d0de), etc.
- [x] Load Inter via `@expo-google-fonts/inter`
- [x] Load JetBrains Mono via `@expo-google-fonts/jetbrains-mono`
- [x] Dark mode variant (invert background/foreground, keep primary terracotta)
- [ ] Glass-morphism: `expo-blur` BlurView with tint="light" for native backdrop-blur
- [x] System theme detection (`useColorScheme()`)
- **Output**: Native design system matching the web shell

### T872 [US43] Gateway client library
- [x] Create `apps/mobile/lib/gateway-client.ts`
- [x] WebSocket connection (same protocol as shell: `/ws` endpoint)
- [x] HTTP client for REST endpoints (`/api/message`, `/api/tasks`, `/api/channels/status`, etc.)
- [x] Auto-reconnect with exponential backoff
- [x] Bearer token auth header injection
- [x] Connection state: connecting / connected / disconnected / error
- [x] Message send/receive with typed events
- **Output**: Reusable gateway client for all screens

### T873 [US43] Gateway connection screen
- [x] Create `apps/mobile/app/connect.tsx`
- [ ] Three connection methods:
  - [x] Manual: URL input + token input (SecureStore persistence)
  - [ ] QR scan: camera-based QR code scanning (expo-camera)
  - [ ] Cloud: Clerk sign-in -> auto-discover instance URL
- [x] Gateway list: multiple saved gateways, switch between them
- [x] Connection test (hit /health, show success/error)
- [x] Store credentials in `expo-secure-store` (encrypted on device)
- **Output**: Users can connect to any gateway

### T874 [US43] Auth -- Clerk + biometric
- [x] `@clerk/clerk-expo` integration for cloud gateway auth
- [x] Biometric lock gate: `expo-local-authentication` for FaceID/TouchID/fingerprint
- [x] Setting to enable/disable biometric lock
- [x] Auth state persisted across app restarts
- **Output**: Secure app access

---

## Phase B: Chat Screen (T875-T880)

### Tests (TDD -- write FIRST)

- [ ] T875a [US39] Write `apps/mobile/__tests__/ChatMessage.test.tsx`:
  - Renders user message with correct styling
  - Renders assistant message with different styling
  - Code blocks render with monospace font
  - Images render inline
  - Streaming message shows typing indicator
  - Long messages are scrollable

### T875 [US39] Chat message list
- [x] Create `apps/mobile/app/(tabs)/chat.tsx`
- [x] FlatList inverted (newest at bottom)
- [x] Message bubbles: user (right-aligned, primary bg) / assistant (left-aligned, card bg)
- [x] Timestamps, read indicators
- [x] Scroll to bottom on new message
- [ ] Pull to load older messages
- **Output**: Message list matching shell's ChatPanel

### T876 [US39] Chat input bar
- [x] Create `apps/mobile/components/InputBar.tsx`
- [x] Matches shell design: rounded-xl border, bg-card/90 with BlurView, shadow-lg
- [x] TextInput with auto-grow (up to 4 lines)
- [x] Send button (terracotta primary) -- disabled when empty
- [x] Keyboard avoiding view (auto-scroll above keyboard)
- **Output**: Chat input matching shell style

### T877 [US39] Streaming responses
- [x] WebSocket streaming: render chunks as they arrive
- [x] Typing indicator animation (three dots pulse)
- [x] Smooth scroll to latest chunk during streaming
- [x] Handle stream interruption gracefully
- **Output**: Real-time streaming chat

### T878 [US39] Code blocks + syntax highlighting
- [x] Detect markdown code blocks in messages
- [x] Render with JetBrains Mono font, dark background
- [x] Language label badge
- [ ] Copy button (clipboard)
- [ ] Horizontal scroll for wide code
- **Output**: Readable code in chat

### T879 [P] [US39] Image + file rendering
- [ ] Inline image rendering (from /files/* gateway endpoint)
- [ ] File attachment cards (name, size, download button)
- [ ] Image tap to full-screen view
- **Output**: Media in chat

### T880 [P] [US39] Voice input
- [ ] Microphone button in InputBar
- [ ] `expo-speech` for speech-to-text
- [ ] Hold-to-record pattern (haptic feedback on start/stop)
- [ ] Transcribed text auto-fills input
- **Output**: Hands-free input

---

## Phase C: Mission Control + Settings (T881-T886)

### T881 [US40] Task list screen
- [x] Create `apps/mobile/app/(tabs)/mission-control.tsx`
- [x] Fetch tasks from `GET /api/tasks`
- [x] Filter chips: All / Todo / In Progress / Done
- [x] Task cards: title, status badge, assignee, priority indicator
- [x] Pull to refresh
- **Output**: Mobile task board

### T882 [US40] Task detail bottom sheet
- [ ] `@gorhom/bottom-sheet` for task detail view
- [x] Tap task card -> slide up detail sheet
- [x] Shows: title, description, status, assignee, created date
- [ ] Mark complete / reopen actions
- [ ] Swipe down to dismiss
- **Output**: Task detail with gesture interaction

### T883 [US40] Add task + cron overview
- [x] FAB (floating action button, terracotta) -> add task form
- [x] Task form: title, description, priority
- [x] POST `/api/tasks` to create
- [x] Cron section below tasks: list upcoming runs from `GET /api/cron`
- [x] Next run time, status badges
- **Output**: Task creation and cron visibility

### T884 [US42] Settings screen
- [x] Create `apps/mobile/app/(tabs)/settings.tsx`
- [ ] Sections:
  - [x] **Gateways**: list saved gateways, add/remove/switch, connection status
  - [ ] **Agent**: soul.md preview (read-only), agent name
  - [x] **Channels**: status badges (connected/error) from `/api/channels/status`
  - [x] **Notifications**: toggle per notification type
  - [x] **Security**: biometric lock toggle
  - [x] **Appearance**: system/light/dark theme
  - [x] **About**: version, Matrix OS logo, link to matrix-os.com
- **Output**: Settings hub

### T885 [P] [US40] Channel status display
- [x] Fetch from `GET /api/channels/status`
- [x] Badge per channel: green (connected), yellow (degraded), red (error), gray (not configured)
- [ ] Tap channel -> detail card with last message time, error details
- **Output**: Channel health at a glance

### T886 [P] App navigation + tab bar
- [x] Bottom tab bar: Chat (MessageSquare icon), Mission Control (LayoutGrid icon), Settings (Settings icon)
- [x] Active tab: terracotta color, inactive: muted-foreground
- [x] Smooth transitions between tabs
- [ ] Badge on Chat tab for unread messages
- **Output**: Polished navigation

---

## Phase D: Push Notifications + Polish (T887-T892)

### T887 [US41] Expo Push Notifications -- mobile side
- [x] `expo-notifications` setup
- [x] Request notification permissions on first launch
- [x] Register Expo Push Token with gateway (`POST /api/push/register`)
- [ ] Handle notification tap -> navigate to relevant screen (chat, task, etc.)
- [ ] Notification categories: message, task, cron, security
- **Output**: Mobile receives push notifications

### T888 [US41] Push notification channel adapter -- gateway side
- [x] Create `packages/gateway/src/channels/push.ts`
- [x] Implements ChannelAdapter interface
- [x] Stores push tokens per user (in config or DB)
- [x] Sends via Expo Push API (`https://exp.host/--/api/v2/push/send`)
- [ ] Notification triggers: new agent message, task status change, cron result, security alert
- [x] Rate limiting (max N pushes per minute)
- **Output**: Gateway can push to mobile devices

### T889 [P] App icon + splash screen
- [x] App icon: Matrix OS logo (terracotta on lavender background)
- [x] Adaptive icon for Android (foreground: logo, background: lavender)
- [x] Splash screen: centered logo on lavender, fade transition
- [ ] Generate all required sizes via `expo-image-utils`
- **Output**: Branded app presence

### T890 [P] Build configuration (EAS Build)
- [x] `eas.json` with development, preview, and production profiles
- [x] iOS: provisioning profile, bundle ID `com.matrixos.mobile`
- [x] Android: signing key, package name `com.matrixos.mobile`
- [ ] Development build for testing (`eas build --profile development`)
- **Output**: Buildable app for both platforms

### T891 [P] Offline resilience
- [ ] Cache last N messages locally (AsyncStorage or SQLite)
- [ ] Queue outbound messages when offline, send on reconnect
- [ ] Show connection state in header (banner or badge)
- **Output**: App usable with spotty connectivity

### T892 [P] Haptic feedback + animations
- [ ] Haptic on send message, task complete, notification receive
- [ ] `react-native-reanimated` for smooth list animations
- [ ] Tab switch spring animation
- [ ] Bottom sheet spring gesture
- **Output**: Native-feeling interactions

---

## Checkpoint

1. Open app -> connect to local gateway (http://localhost:4000) -> chat with agent -> streaming responses render.
2. Open Mission Control tab -> see tasks -> tap task -> bottom sheet detail -> mark complete.
3. Close app -> agent sends message -> push notification appears -> tap -> opens chat.
4. App uses terracotta/lavender design, Inter font, glass blur on input bar.
5. QR scan gateway URL from shell -> auto-connects.
6. Enable biometric lock -> close/reopen app -> FaceID/fingerprint required.
7. Switch between light/dark mode -> colors adapt.
