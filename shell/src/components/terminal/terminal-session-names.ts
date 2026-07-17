import {
  createShellSessionName,
  SHELL_SESSION_ADJECTIVES,
  SHELL_SESSION_NOUNS,
} from "@matrix-os/contracts";

export { SHELL_SESSION_ADJECTIVES, SHELL_SESSION_NOUNS };

/** Returns a friendly session handle like "swift-falcon". */
export function twoWordSessionName(): string {
  return createShellSessionName();
}

/**
 * Deterministic accent color for a session, derived from its name so the same
 * session is always the same hue. Light tinted chip + matching darker text, so
 * sessions are told apart by color, not just a 2-3 letter abbreviation.
 */
export function sessionAccent(name: string): { bg: string; fg: string; border: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return {
    bg: `hsl(${hue} 58% 90%)`,
    fg: `hsl(${hue} 50% 30%)`,
    border: `hsl(${hue} 44% 78%)`,
  };
}
