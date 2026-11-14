# Native Mobile: motion and feel

## Problem and result

The phone app looks finished but feels static. Only a few screens animate,
pressed controls dim by four different amounts or not at all, haptics fire
only when the side panel opens, the launch passes through up to four loading
layouts and a white flash in dark mode, secondary screens can only be left
with a 32pt X, content pops in, rows vanish, and confirmations are two
hand-made popups.

After this change the app moves the same way everywhere, from one set of
timings, and every touch gets feedback that matches what it did. No new
capability, data or setting is added: every change is to how existing
screens and actions look, move and feel.

## Surfaces

| Surface | Change | Why |
| --- | --- | --- |
| Native Mobile | Everything below | This change |
| Web Canvas, Web Desktop, Electron Desktop, Web Mobile | None | Interaction polish only (motion, haptics, navigation presentation, loading shapes). The long-press menus offer only actions the same screen already offers, so nothing new reaches users that other surfaces lack. |

## Behaviour

### Motion kit (layer 1)

- `lib/theme-v2.ts` `motion`: durations 120, 200 and 300 ms, a snappy and a
  gentle spring, and the press scales (0.97 for buttons and tiles, 0.985 for
  rows as wide as the screen). Animations take their timing from here.
- A pressed button, tile or row shrinks to its press scale and springs back
  on release, on the UI thread. With Reduce Motion on it dims instead.
- Icon buttons drawn smaller than 44pt answer a press on a 44pt square, and
  the 32pt close and back buttons dim when pressed.
- `lib/haptics.ts` has four calls: tap (send, side panel), select (model and
  option picks, switches), success and warning (every toast plays the one
  matching its tone). The side panel's haptic is lighter than before.

### Launch and navigation (layer 2)

- The native splash fades out (iOS) onto a startup screen that draws the same
  rabbit in the same place. Every wait at launch uses that one screen with
  one spinner, and it cross-fades into the app instead of sliding.
- The first frame is drawn in the theme chosen in Settings, or the device's,
  read before anything draws: no light frame before a dark app.
- Changing tabs shifts the screens a little (a cross-fade with Reduce Motion),
  a highlight slides under the active tab, and a selection haptic plays.
- Pulling a list or page to refresh plays the tap haptic as the refresh starts.
- Settings pages open as pages and go back with a swipe from the left edge;
  Files and Installed integrations open as sheets and close with a swipe
  down. Only the terminal and app previews stay full screen.

### Content settles in (layer 3)

- Loading placeholders take the shape of the rows that replace them, use one
  style, and run on the UI thread. With Reduce Motion they hold still.
- Lists fade in when they replace their placeholders; rows that leave fade
  out while the rest move up; remote logos and photos fade in.

### Menus and confirmations (layer 4)

- Renaming, deleting and archiving end with a short toast and its haptic.
- A long press on a terminal, project or agent row opens the native menu the
  chat rows use, with the actions that item already has: Rename and Delete
  for a terminal, Rename and Archive for a project, Archive for an agent.
- One confirm dialog replaces the two hand-made popups; a destructive one
  plays the warning haptic as it opens.

### Keyboard and sending (layer 5)

- The chat, project and agent screens follow the keyboard frame by frame on
  iOS and Android (`react-native-keyboard-controller`), so the composer
  travels with the keyboard instead of jumping to where it will end, or on
  Android after it has landed. The composer's smaller gap above the keyboard
  applies as the keyboard starts to move, on both platforms.
- A message sent from the phone rises into place above the composer as it
  fades in, and a reply fades in as it starts. The greeting fades out as the
  first message takes its place. Only messages still arriving animate, so
  scrolling never replays one. With Reduce Motion a new message only fades in.
- The messages already there move as before. Gliding them was tried: in a long
  chat it ran only some of the time, and it made a streaming reply wobble as
  each line was added.
- The package's provider is mounted on both platforms. The app is edge to
  edge, so Android draws the keyboard over the screen as iOS does, and these
  screens already make room for it themselves (HamedMP/matrix-os#2706). The
  provider sees the edge-to-edge setup and keeps the status and navigation
  bars translucent by itself, so its `statusBarTranslucent`,
  `navigationBarTranslucent` and `preserveEdgeToEdge` options stay unset.

## Acceptance checks

- Unit tests cover the tokens' use, the press scale and its reduced-motion
  fallback, each haptic call site, the launch theme, the root presentations,
  the placeholders' shapes and every new or changed dialog, menu and toast.
- On the iPhone 17 simulator: tab changes, a press held on a row, a Settings
  page pushed and swiped back, the Files sheet swiped down, a dark-mode
  cold launch, and the keyboard opening and a message sent in a chat, each
  recorded and checked frame by frame.
- On the Android emulator with the on-screen keyboard: the keyboard opening
  and closing on a new chat, an open chat, a project and an agent chat, with
  the status bar, tab bar and terminal unchanged.

## Risks and limits

- Layers 1 to 4 are JavaScript and can ship as an over-the-air update.
  Layer 5 adds a native module, so it bumps the app version to 0.2.8, and
  updates from then on reach only 0.2.8 builds. Merged together, all five
  layers reach people with the 0.2.8 store build; merging layers 1 to 4
  first lets them reach 0.2.7 installs over the air. A dark native splash
  image also needs a store build and is not part of this.
- Moving the agent chat and new-agent screens out of the tabs (so the tab bar
  leaves with them) changes navigation structure and is left for its own
  change.
- App tiles get no long-press menu: there is no action on a tile besides
  opening it, and adding one would be a new capability for every surface.
- The two collaboration sheets (session discussion and access) still use
  React Native's Modal. Moving them into the shared native sheet needs their
  list and keyboard layout reworked inside it, and they only appear in
  shared sessions; it is left for its own change, checked on a shared session.
- Other screens with a text field (sign-in, shared chats, the terminal
  session, the text-entry dialog and the discussion sheet) still use React
  Native's keyboard-avoiding view with no Android behaviour, so on Android
  the keyboard can cover what sits at their bottom edge. The terminal
  session's key row also sits under Android's navigation bar, on `main` too.
  Both are left for their own change.
- Public docs: none. No user-facing capability or setting changes.
