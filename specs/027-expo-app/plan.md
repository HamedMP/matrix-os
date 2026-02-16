# Plan: Expo Mobile App

**Spec**: `specs/027-expo-app/spec.md`
**Depends on**: Gateway API (complete), Gateway auth (complete), Mission Control API (complete)
**Estimated effort**: Large (20 tasks + TDD)

## Approach

Start with project scaffolding and gateway connection (the hardest integration point). Then build the chat screen (core value prop). Then Mission Control and Settings. Push notifications last since they require the most gateway-side changes.

### Phase A: Project Setup (T870-T874)

1. Expo project scaffold with TypeScript strict, Expo Router, NativeWind
2. Design system: theme tokens, font loading (Inter + JetBrains Mono), color scheme
3. Gateway client library (WebSocket + HTTP, same protocol as shell)
4. Gateway connection screen (manual URL, QR scan, cloud login)
5. Auth: Clerk for cloud, biometric lock with expo-local-authentication

### Phase B: Chat Screen (T875-T880)

1. Message list (FlatList inverted, message bubbles)
2. Input bar (matches shell design: rounded-xl, backdrop blur)
3. Streaming WebSocket responses with typing indicator
4. Code blocks with syntax highlighting
5. Image/file inline rendering
6. Voice input (expo-speech)

### Phase C: Mission Control + Settings (T881-T886)

1. Task list with filter chips
2. Task detail bottom sheet
3. Add task + cron overview
4. Settings: gateway management, notifications, biometric, theme
5. Channel status badges

### Phase D: Push Notifications + Polish (T887-T892)

1. Expo Push Notifications registration
2. Gateway push channel adapter
3. Notification routing (tap notification -> open relevant screen)
4. App icon + splash screen (branded assets)
5. Build configuration (EAS Build for iOS + Android)
6. TestFlight / Play Store internal track

## Files to Create

- `apps/mobile/` -- entire Expo project (see spec for structure)
- `packages/gateway/src/channels/push.ts` -- push notification channel adapter

## Files to Modify

- `packages/gateway/src/channels/manager.ts` -- register push adapter
- `pnpm-workspace.yaml` -- add `apps/mobile` (optional, can be standalone)

## New Dependencies (in apps/mobile)

- `expo` ~52 + `expo-router` ~4
- `nativewind` ~4 + `tailwindcss` ~4
- `@clerk/clerk-expo` -- Clerk auth
- `expo-local-authentication` -- biometric
- `expo-secure-store` -- secure key storage
- `expo-notifications` -- push notifications
- `expo-camera` -- QR code scanning
- `expo-blur` -- glass-morphism BlurView
- `@expo-google-fonts/inter` + `@expo-google-fonts/jetbrains-mono`
- `react-native-reanimated` -- animations
- `react-native-gesture-handler` -- gestures (bottom sheet)
- `@gorhom/bottom-sheet` -- bottom sheet
