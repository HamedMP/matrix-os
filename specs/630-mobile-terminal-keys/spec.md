# Native Mobile: terminal keys for coding agents

## Problem and result

Driving a coding agent (Codex, Claude Code) in the phone's terminal is hard.
Its menus need up and down, but the arrows sit in a six-row grid that hides
most of the terminal once opened; the iOS form toolbar above the keyboard
shows up and down chevrons that only move between form fields; the grid
stays open after Enter and after the keyboard goes down; the bottom row
then sits under the home indicator; there is no way to put the cursor
somewhere in a typed line; and the grid offers zellij mode keys (^G, ^P,
^O, ^T) that switch the shared terminal session instead of reaching the
program.

After this change the keys an agent needs are always one tap away, the
extra keys fit on two short pages and fold away on their own, and the
cursor follows a tap or a swipe.

## Surfaces

| Surface | Change | Why |
| --- | --- | --- |
| Native Mobile | Everything below | This change |
| Web Canvas, Web Desktop, Electron Desktop | None | They have a hardware keyboard and their own terminal chrome; no key rows. |
| Web Mobile | None | Rendered by the web shell's own terminal, not these key rows. |

## Behaviour

- Main row, always shown: Stop (Ctrl+C), esc, tab, ctrl, up, down, a
  keyboard key (hides the keyboard while it is up, brings it up while it is
  down), ⋯ (opens and closes the extra pages), Enter.
- ctrl is sticky: pressing it arms it (drawn inverted) and brings up the
  keyboard; the next letter or control punctuation typed is sent as its
  control key and disarms it. Another key from the rows, or a tap that moves
  the cursor, also disarms it and is sent as it is. Replies the emulator
  sends to the program (they start with ESC, which the on-screen keyboard
  never types) leave it armed.
- Extra page 1: left, right, Home, End, Shift+Tab, Paste and symbols
  (/ ~ | - _ $ * >). Page 2: Kill line, Search history, Clear screen,
  Page up, Page down, Scroll to bottom. A page key turns between them.
- The extra pages fold away when Enter is pressed (from the rows or the
  keyboard) and when the keyboard goes down.
- With the keyboard down the rows keep clear of the home indicator.
- Every row fits a 320pt wide screen: keys keep their width while a row fits
  and shrink together, down to a floor, when it does not.
- A sideways swipe across the rows sends left or right, one per 14pt, and
  takes them back if the finger returns; an up or down swipe sends up or
  down, one per 20pt. A short wobble stays a tap on the key underneath.
- A tap on the line being typed moves the cursor there by sending left or
  right arrows (the program's application-cursor form when it asked for
  it). It goes no further than the end of the text and does nothing on
  other lines, while scrolled back, or while the program hides the cursor.
  Positions are counted in screen cells; a wide character (CJK, emoji) is
  two cells but one arrow press. The emulator's mouse mode is not a signal:
  zellij always asks for the mouse.
- The iOS form toolbar above the keyboard is hidden.
- No zellij mode keys are offered.

## Acceptance

- Codex's update prompt: Skip is chosen with one ↓ and Enter, with the
  whole menu in view.
- In a shell and in Codex's input, a tap inside the text moves the cursor
  there; a tap on another line moves nothing.
- Unit tests cover the control-key mapping, swipe steps, the tap rule, the
  pages, folding on Enter and on keyboard hide, the safe-area padding and
  the absence of zellij keys.

## Security and resources

No new endpoint, socket message or stored state. Arrow keys from a tap are
built in the page from the emulator's own state and travel the existing
input path. The keyboard listeners are removed on unmount.

## Risks

- Every change in visible rows (keyboard, extra pages) still resizes the
  terminal on the computer, and some programs redraw their last line when
  that happens. This was already true of the keyboard; the fix belongs to
  the resize work, not here.
- Tap-to-move assumes the program edits a single line; on a line that
  wraps it only moves within the cursor's own row.

## Docs

If the public mobile terminal docs in `FinnaAI/matrix-os-site`
(`content/docs/`) describe the key rows, update them in a follow-up PR;
done when they list the main row, the two pages and tap-to-move.
