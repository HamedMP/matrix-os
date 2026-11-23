// Keys a focused Terminal handles itself (specs/653). The window that hosts
// the Terminal reports them; the input matcher leaves those keys to that web
// contents instead of running an Apps shortcut. Claims are a hint toward the
// page, so losing one only brings back today's behavior: the shortcut runs.
import { isCanonicalBinding, type ShortcutPlatform } from "@matrix-os/contracts/keyboard-shortcuts";
import { MAX_TERMINAL_CLAIMS } from "../../shared/shortcuts-ipc";

// Only the main and Terminal windows may claim (sender policy); this is slack.
export const MAX_CLAIMANTS = 8;

export interface TerminalClaims {
  /** Replaces `target`'s claims; an empty list ends them. */
  set(target: object, bindings: readonly string[]): void;
  clear(target: object): void;
  has(target: object, binding: string): boolean;
  size(): number;
  clearAll(): void;
}

export function createTerminalClaims(platform: ShortcutPlatform): TerminalClaims {
  // Keys are web contents objects, used only as identities: a destroyed one is
  // never touched, only deleted.
  const claims = new Map<object, ReadonlySet<string>>();
  return {
    set(target, bindings) {
      claims.delete(target);
      const kept = new Set<string>();
      for (const binding of bindings) {
        if (kept.size >= MAX_TERMINAL_CLAIMS) break;
        if (isCanonicalBinding(binding, platform)) kept.add(binding);
      }
      if (kept.size === 0) return;
      claims.set(target, kept);
      // Oldest first, so evicting one ends the stalest claim.
      for (const oldest of claims.keys()) {
        if (claims.size <= MAX_CLAIMANTS) break;
        claims.delete(oldest);
      }
    },
    clear(target) {
      claims.delete(target);
    },
    has(target, binding) {
      return claims.get(target)?.has(binding) ?? false;
    },
    size() {
      return claims.size;
    },
    clearAll() {
      claims.clear();
    },
  };
}
