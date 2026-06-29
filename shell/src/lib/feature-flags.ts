// Shell feature flags — flip to re-enable a surface.
//
// Hermes chat is hidden from the dock/sidebar and the apps grid for now, to
// keep the shell minimal while the chat experience is still being finished.
// The built-in `__chat__` wiring stays intact (so it can be re-surfaced or
// opened programmatically); only the user-facing launchers are gated.
export const HERMES_CHAT_HIDDEN = true;
