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
- [ ] Create `apps/mobile/` with `npx create-expo-app@latest --template tabs`
- [ ] TypeScript strict mode (`tsconfig.json` strict: true)
- [ ] Expo Router v4 with file-based routing
- [ ] NativeWind v5 + Tailwind CSS v4 setup
- [ ] ESLint + Prettier matching project conventions
- **Output**: Clean Expo project that builds and runs

### T871 [US42] Design system -- theme + fonts
- [ ] Create `apps/mobile/lib/theme.ts` -- all design tokens from specs/design-guide.md
- [ ] Colors: background (#ece5f0), card (#ffffff), primary (#c2703a), border (#d8d0de), etc.
- [ ] Load Inter via `@expo-google-fonts/inter`
- [ ] Load JetBrains Mono via `@expo-google-fonts/jetbrains-mono`
- [ ] Dark mode variant (invert background/foreground, keep primary terracotta)
- [ ] Glass-morphism: `expo-blur` BlurView with tint="light" for native backdrop-blur
- [ ] System theme detection (`useColorScheme()`)
- **Output**: Native design system matching the web shell

### T872 [US43] Gateway client library
- [ ] Create `apps/mobile/lib/gateway-client.ts`
- [ ] WebSocket connection (same protocol as shell: `/ws` endpoint)
- [ ] HTTP client for REST endpoints (`/api/message`, `/api/tasks`, `/api/channels/status`, etc.)
- [ ] Auto-reconnect with exponential backoff
- [ ] Bearer token auth header injection
- [ ] Connection state: connecting / connected / disconnected / error
- [ ] Message send/receive with typed events
- **Output**: Reusable gateway client for all screens

### T873 [US43] Gateway connection screen
- [ ] Create `apps/mobile/app/connect.tsx`
- [ ] Three connection methods:
  - [ ] Manual: URL input + token input (SecureStore persistence)
  - [ ] QR scan: camera-based QR code scanning (expo-camera)
  - [ ] Cloud: Clerk sign-in -> auto-discover instance URL
- [ ] Gateway list: multiple saved gateways, switch between them
- [ ] Connection test (hit /health, show success/error)
- [ ] Store credentials in `expo-secure-store` (encrypted on device)
- **Output**: Users can connect to any gateway

### T874 [US43] Auth -- Clerk + biometric
- [ ] `@clerk/clerk-expo` integration for cloud gateway auth
- [ ] Biometric lock gate: `expo-local-authentication` for FaceID/TouchID/fingerprint
- [ ] Setting to enable/disable biometric lock
- [ ] Auth state persisted across app restarts
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
- [ ] Create `apps/mobile/app/(tabs)/chat.tsx`
- [ ] FlatList inverted (newest at bottom)
- [ ] Message bubbles: user (right-aligned, primary bg) / assistant (left-aligned, card bg)
- [ ] Timestamps, read indicators
- [ ] Scroll to bottom on new message
- [ ] Pull to load older messages
- **Output**: Message list matching shell's ChatPanel

### T876 [US39] Chat input bar
- [ ] Create `apps/mobile/components/InputBar.tsx`
- [ ] Matches shell design: rounded-xl border, bg-card/90 with BlurView, shadow-lg
- [ ] TextInput with auto-grow (up to 4 lines)
- [ ] Send button (terracotta primary) -- disabled when empty
- [ ] Keyboard avoiding view (auto-scroll above keyboard)
- **Output**: Chat input matching shell style

### T877 [US39] Streaming responses
- [ ] WebSocket streaming: render chunks as they arrive
- [ ] Typing indicator animation (three dots pulse)
- [ ] Smooth scroll to latest chunk during streaming
- [ ] Handle stream interruption gracefully
- **Output**: Real-time streaming chat

### T878 [US39] Code blocks + syntax highlighting
- [ ] Detect markdown code blocks in messages
- [ ] Render with JetBrains Mono font, dark background
- [ ] Language label badge
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
- [ ] Create `apps/mobile/app/(tabs)/mission-control.tsx`
- [ ] Fetch tasks from `GET /api/tasks`
- [ ] Filter chips: All / Todo / In Progress / Done
- [ ] Task cards: title, status badge, assignee, priority indicator
- [ ] Pull to refresh
- **Output**: Mobile task board

### T882 [US40] Task detail bottom sheet
- [ ] `@gorhom/bottom-sheet` for task detail view
- [ ] Tap task card -> slide up detail sheet
- [ ] Shows: title, description, status, assignee, created date
- [ ] Mark complete / reopen actions
- [ ] Swipe down to dismiss
- **Output**: Task detail with gesture interaction

### T883 [US40] Add task + cron overview
- [ ] FAB (floating action button, terracotta) -> add task form
- [ ] Task form: title, description, priority
- [ ] POST `/api/tasks` to create
- [ ] Cron section below tasks: list upcoming runs from `GET /api/cron`
- [ ] Next run time, status badges
- **Output**: Task creation and cron visibility

### T884 [US42] Settings screen
- [ ] Create `apps/mobile/app/(tabs)/settings.tsx`
- [ ] Sections:
  - [ ] **Gateways**: list saved gateways, add/remove/switch, connection status
  - [ ] **Agent**: soul.md preview (read-only), agent name
  - [ ] **Channels**: status badges (connected/error) from `/api/channels/status`
  - [ ] **Notifications**: toggle per notification type
  - [ ] **Security**: biometric lock toggle
  - [ ] **Appearance**: system/light/dark theme
  - [ ] **About**: version, Matrix OS logo, link to matrix-os.com
- **Output**: Settings hub

### T885 [P] [US40] Channel status display
- [ ] Fetch from `GET /api/channels/status`
- [ ] Badge per channel: green (connected), yellow (degraded), red (error), gray (not configured)
- [ ] Tap channel -> detail card with last message time, error details
- **Output**: Channel health at a glance

### T886 [P] App navigation + tab bar
- [ ] Bottom tab bar: Chat (MessageSquare icon), Mission Control (LayoutGrid icon), Settings (Settings icon)
- [ ] Active tab: terracotta color, inactive: muted-foreground
- [ ] Smooth transitions between tabs
- [ ] Badge on Chat tab for unread messages
- **Output**: Polished navigation

---

## Phase D: Push Notifications + Polish (T887-T892)

### T887 [US41] Expo Push Notifications -- mobile side
- [ ] `expo-notifications` setup
- [ ] Request notification permissions on first launch
- [ ] Register Expo Push Token with gateway (`POST /api/push/register`)
- [ ] Handle notification tap -> navigate to relevant screen (chat, task, etc.)
- [ ] Notification categories: message, task, cron, security
- **Output**: Mobile receives push notifications

### T888 [US41] Push notification channel adapter -- gateway side
- [ ] Create `packages/gateway/src/channels/push.ts`
- [ ] Implements ChannelAdapter interface
- [ ] Stores push tokens per user (in config or DB)
- [ ] Sends via Expo Push API (`https://exp.host/--/api/v2/push/send`)
- [ ] Notification triggers: new agent message, task status change, cron result, security alert
- [ ] Rate limiting (max N pushes per minute)
- **Output**: Gateway can push to mobile devices

### T889 [P] App icon + splash screen
- [ ] App icon: Matrix OS logo (terracotta on lavender background)
- [ ] Adaptive icon for Android (foreground: logo, background: lavender)
- [ ] Splash screen: centered logo on lavender, fade transition
- [ ] Generate all required sizes via `expo-image-utils`
- **Output**: Branded app presence

### T890 [P] Build configuration (EAS Build)
- [ ] `eas.json` with development, preview, and production profiles
- [ ] iOS: provisioning profile, bundle ID `com.matrixos.mobile`
- [ ] Android: signing key, package name `com.matrixos.mobile`
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
