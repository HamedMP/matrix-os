// Runs keyboard shortcuts from `before-input-event` (specs/653). The event
// fires before the page sees the key, so a page that swallows keys (xterm)
// cannot block a shortcut, and preventDefault() also stops the matching menu
// accelerator, so the action runs once. Terminal control chords are the
// exception: they are left to the page and the menu (see isTerminalControlChord).
import {
  bindingFromKeyEvent,
  SHORTCUT_ACTION_IDS,
  type EffectiveShortcuts,
  type ShortcutActionId,
  type ShortcutPlatform,
} from "@matrix-os/contracts/keyboard-shortcuts";

export interface ShortcutInput {
  type: string;
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
  isAutoRepeat: boolean;
}

// Holding these steps through apps; every other action runs once per press.
const REPEATABLE: ReadonlySet<ShortcutActionId> = new Set(["app.next", "app.previous"]);

/**
 * Ctrl alone plus a letter or `[`, `\`, `]`: a terminal control character
 * (Ctrl+W deletes a word). The matcher leaves these to the page; they run only
 * through menu accelerators, which a terminal can claim by cancelling the key.
 */
export function isTerminalControlChord(binding: string): boolean {
  const match = /^Ctrl\+(.+)$/.exec(binding);
  if (!match) return false;
  const key = match[1]!;
  return /^[A-Z]$/.test(key) || key === "[" || key === "\\" || key === "]";
}

export function createShortcutInputMatcher(deps: {
  effective(): EffectiveShortcuts;
  platform: ShortcutPlatform;
  isRecording(): boolean;
  /** False for actions that do not exist on this platform. */
  isAvailable(id: ShortcutActionId): boolean;
  run(id: ShortcutActionId): void;
}): (event: { preventDefault(): void }, input: ShortcutInput) => void {
  // Rebuilt only when effective() returns a different object.
  let indexed: EffectiveShortcuts | null = null;
  let actionByBinding = new Map<string, ShortcutActionId>();

  function lookup(binding: string): ShortcutActionId | undefined {
    const effective = deps.effective();
    if (effective !== indexed) {
      // Bounded by the registry: at most MAX_BINDINGS_PER_ACTION per action.
      actionByBinding = new Map();
      for (const id of SHORTCUT_ACTION_IDS) {
        if (!deps.isAvailable(id)) continue;
        for (const bound of effective[id] ?? []) {
          if (!isTerminalControlChord(bound)) actionByBinding.set(bound, id);
        }
      }
      indexed = effective;
    }
    return actionByBinding.get(binding);
  }

  return (event, input) => {
    if (input.type !== "keyDown" || deps.isRecording()) return;
    // The same function the recorder uses, so a recorded key matches on any layout.
    const binding = bindingFromKeyEvent({
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
      shiftKey: input.shift,
    }, deps.platform);
    if (binding === null) return;
    const id = lookup(binding);
    if (id === undefined) return;
    // A held key still must not reach the page as a stream of shortcut keys.
    event.preventDefault();
    if (input.isAutoRepeat && !REPEATABLE.has(id)) return;
    deps.run(id);
  };
}
