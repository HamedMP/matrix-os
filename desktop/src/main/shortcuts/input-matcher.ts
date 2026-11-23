// Runs keyboard shortcuts from `before-input-event` (specs/653). The event
// fires before the page sees the key, so a page that swallows keys (xterm)
// cannot block a shortcut, and preventDefault() also stops the matching menu
// accelerator, so the action runs once. It carries only the Apps group, and
// never terminal control chords; everything else is left to the page and the
// menu, so apps inside Matrix can still claim keys such as Cmd+N. A focused
// Terminal also keeps the keys its active profile binds (isClaimed).
import {
  bindingFromKeyEvent,
  characterBindingFromKeyEvent,
  SHORTCUT_ACTIONS,
  validateBinding,
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
 * Ctrl alone plus a letter, Space or `[`, `\`, `]`: a terminal control
 * character (Ctrl+W deletes a word, Ctrl+Space sets the mark; it is also the
 * Windows IME toggle). The matcher leaves these to the page; they run only
 * through menu accelerators, which a terminal can claim by cancelling the key.
 */
export function isTerminalControlChord(binding: string): boolean {
  const match = /^Ctrl\+(.+)$/.exec(binding);
  if (!match) return false;
  const key = match[1]!;
  return /^[A-Z]$/.test(key) || key === "Space" || key === "[" || key === "\\" || key === "]";
}

const MAIN_PROCESS_ACTIONS: ReadonlySet<ShortcutActionId> = new Set(
  SHORTCUT_ACTIONS.filter((action) => action.group === "apps").map((action) => action.id),
);

/**
 * Apps-group actions must work with focus anywhere, so the main process runs
 * them before the page. Other groups run only through menu accelerators, which
 * a focused page can claim by cancelling the key.
 */
export function isMainProcessShortcut(id: ShortcutActionId): boolean {
  return MAIN_PROCESS_ACTIONS.has(id);
}

/** Whether the matcher runs this binding; the menu adds hidden items for the rest. */
export function isCarriedByMatcher(id: ShortcutActionId, binding: string): boolean {
  return isMainProcessShortcut(id) && !isTerminalControlChord(binding);
}

export function createShortcutInputMatcher(deps: {
  effective(): EffectiveShortcuts;
  platform: ShortcutPlatform;
  isRecording(): boolean;
  /** False for actions that do not exist on this platform. */
  isAvailable(id: ShortcutActionId): boolean;
  /** True when a Terminal focused in `source` handles this binding itself. */
  isClaimed(source: object, binding: string): boolean;
  run(id: ShortcutActionId): void;
}): (event: { preventDefault(): void }, input: ShortcutInput, source: object) => void {
  // Rebuilt only when effective() returns a different object.
  let indexed: EffectiveShortcuts | null = null;
  let actionByBinding = new Map<string, ShortcutActionId>();

  function lookup(binding: string): ShortcutActionId | undefined {
    const effective = deps.effective();
    if (effective !== indexed) {
      // Bounded by the registry: at most MAX_BINDINGS_PER_ACTION per action.
      actionByBinding = new Map();
      for (const id of MAIN_PROCESS_ACTIONS) {
        if (!deps.isAvailable(id)) continue;
        for (const bound of effective[id] ?? []) {
          if (isCarriedByMatcher(id, bound)) actionByBinding.set(bound, id);
        }
      }
      indexed = effective;
    }
    return actionByBinding.get(binding);
  }

  return (event, input, source) => {
    if (input.type !== "keyDown" || deps.isRecording()) return;
    // The same function the recorder uses, so a recorded key matches on any layout.
    const keyEvent = {
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
      shiftKey: input.shift,
    };
    const binding = bindingFromKeyEvent(keyEvent, deps.platform);
    if (binding === null) return;
    // A digit-row key that types a native menu key (AZERTY: Cmd+- on the 6 key
    // zooms out) belongs to the menu, not to the digit's shortcut.
    const typed = characterBindingFromKeyEvent(keyEvent, deps.platform);
    if (typed !== null && typed !== binding) {
      const check = validateBinding(typed, deps.platform);
      if (!check.ok && (check.reason === "reserved-menu" || check.reason === "reserved-system")) return;
    }
    const id = lookup(binding);
    if (id === undefined || deps.isClaimed(source, binding)) return;
    // A held key still must not reach the page as a stream of shortcut keys.
    event.preventDefault();
    if (input.isAutoRepeat && !REPEATABLE.has(id)) return;
    deps.run(id);
  };
}
