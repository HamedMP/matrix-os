// Whether the Getting Started wizard is open. GetStartedGate blocks background
// shortcuts by stopping keydown in the page, but main matches shortcut keys
// before the page sees them, so the action dispatcher checks this instead.
let holds = 0;

export function isGetStartedBlocking(): boolean {
  return holds > 0;
}

/** Marks the wizard open until the returned release runs (idempotent). */
export function holdGetStartedBlocking(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}
