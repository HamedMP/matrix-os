# 027: Expo Mobile App

## Problem

Matrix OS is only accessible via web browser. While the shell is PWA-capable and mobile-responsive, native mobile provides: push notifications, biometric auth, background sync, camera/microphone access, haptic feedback, and a presence in the app drawer. Moltbot has native iOS/Android/macOS apps. Matrix OS needs a native mobile experience that matches the shell's warm, organic design language.

## Solution

An Expo (React Native) app in `apps/mobile/` that connects to the same gateway WebSocket/HTTP API as the web shell. Shares the same design system (terracotta/lavender/parchment palette, Inter/JetBrains Mono, glass-morphism adapted for native). Three main screens: Chat, Mission Control, and Settings. Uses Expo Router for navigation, NativeWind for styling, and the gateway's existing API.

## Design

### Architecture

```
apps/mobile/              # Expo app (standalone, no monorepo coupling)
  app/                    # Expo Router file-based routing
    (tabs)/               # Bottom tab navigator
      chat.tsx            # Chat screen (main)
      mission-control.tsx # Task board
      settings.tsx        # Settings + config
    _layout.tsx           # Root layout (auth gate, theme provider)
    connect.tsx           # Gateway connection screen
  components/             # Shared UI components
  lib/                    # Gateway client, auth, storage
  assets/                 # App icon, splash, fonts
```

### Gateway Connection

The app connects to a Matrix OS gateway (local or cloud):

```typescript
interface GatewayConnection {
  url: string;           // e.g., "https://hamedmp.matrix-os.com" or "http://192.168.1.100:4000"
  token?: string;        // MATRIX_AUTH_TOKEN for cloud instances
  name: string;          // user-assigned label
}
```

Discovery options:
1. **Manual URL entry** -- type gateway URL + token
2. **QR code scan** -- gateway shows QR in shell with URL + token encoded
3. **Cloud login** -- Clerk auth on matrix-os.com, auto-discover user's instance

### Design System (Native Adaptation)

The shell's design language adapted for native:

| Token | Value | Native Adaptation |
|---|---|---|
| Background | `#ece5f0` (lavender) | `backgroundColor` on root View |
| Card | `#ffffff` | Card components with shadow |
| Primary | `#c2703a` (terracotta) | Buttons, active tab, badges |
| Border | `#d8d0de` | Separator lines, card borders |
| Fonts | Inter / JetBrains Mono | Expo Google Fonts |

Glass-morphism: use `expo-blur` `BlurView` with `tint="light"` and reduced opacity backgrounds.

No traffic lights (those are macOS-specific). Use native navigation patterns:
- iOS: large title navigation bar, swipe back gesture
- Android: Material top bar, back arrow

### Screens

**Chat (main tab)**:
- Message list (FlatList, inverted)
- Input bar at bottom (same style as shell: rounded-xl, bg-card/90, blur backdrop)
- Streaming responses with typing indicator
- Code blocks with syntax highlighting (react-native-reanimated for smooth scroll)
- Image/file attachments inline
- Voice input button (expo-speech for STT)

**Mission Control**:
- Task list (kanban simplified to vertical list on mobile)
- Filter chips: All / Todo / In Progress / Done
- Task detail bottom sheet (gesture-driven)
- Add task FAB (floating action button, terracotta primary)
- Cron job overview (next runs, status badges)

**Settings**:
- Gateway connection management (add/remove/switch)
- Agent persona quick view (soul.md preview)
- Channel status list (connected/error badges)
- Notification preferences
- Biometric lock toggle
- Theme (follows system / light / dark)
- About / version

### Push Notifications

Gateway sends push notifications via the channel adapter pattern:

```typescript
// Gateway: new channel adapter for push notifications
interface PushNotificationAdapter extends ChannelAdapter {
  name: "push";
  send(target: PushToken, message: string): Promise<void>;
}
```

Uses Expo Push Notifications (Expo's push service, no Firebase config needed):
- Register push token with gateway on app connect
- Gateway pushes when: new message from agent, cron job result, task status change, security alert

### Auth

1. **Local gateway**: no auth (or bearer token from config)
2. **Cloud gateway**: Clerk auth (same as matrix-os.com), using `@clerk/clerk-expo`
3. **Biometric lock**: `expo-local-authentication` for FaceID/TouchID/fingerprint gate on app open

## Dependencies

- Gateway HTTP/WS API (Phase 3 -- complete)
- Gateway auth (Phase 008A -- complete)
- Mission Control API (Phase 012 -- complete)

## File Locations

```
apps/mobile/
  app/
    _layout.tsx             # Root layout, providers, auth gate
    connect.tsx             # Gateway connection/discovery screen
    (tabs)/
      _layout.tsx           # Tab navigator (Chat, MC, Settings)
      chat.tsx              # Chat screen
      mission-control.tsx   # Task board
      settings.tsx          # Settings screen
  components/
    ChatMessage.tsx         # Message bubble
    InputBar.tsx            # Chat input (matches shell style)
    TaskCard.tsx            # Task list item
    TaskDetail.tsx          # Task detail bottom sheet
    ChannelBadge.tsx        # Channel status badge
    GatewayCard.tsx         # Gateway connection card
  lib/
    gateway-client.ts       # WebSocket + HTTP client
    auth.ts                 # Clerk + biometric auth
    storage.ts              # Secure storage (expo-secure-store)
    push.ts                 # Push notification registration
    theme.ts                # Design tokens + color scheme
  assets/
    icon.png                # App icon (Matrix OS logo, terracotta on lavender)
    splash.png              # Splash screen
    adaptive-icon.png       # Android adaptive icon
```
