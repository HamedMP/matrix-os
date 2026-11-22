// Runs keyboard shortcuts from `before-input-event` (specs/653). The event
// fires before the page sees the key, so a page that swallows keys (xterm)
// cannot block a shortcut, and preventDefault() also stops the matching menu
// accelerator, so the action runs once.
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
}

export function createShortcutInputMatcher(deps: {
  effective(): EffectiveShortcuts;
  platform: ShortcutPlatform;
  isRecording(): boolean;
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
        for (const bound of effective[id] ?? []) actionByBinding.set(bound, id);
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
    event.preventDefault();
    deps.run(id);
  };
}
