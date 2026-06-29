// Shell feature flags — flip to re-enable a surface.
//
// Hermes chat is hidden from the dock/sidebar and the apps grid for now, to
// keep the shell minimal while the chat experience is still being finished.
// The built-in `__chat__` wiring stays intact (so it can be re-surfaced or
// opened programmatically); only the user-facing launchers are gated.
export const HERMES_CHAT_HIDDEN = true;

// Voice (Aoede) dock button is hidden for now while the voice experience is
// out of the minimal flow. The vocal store/overlay wiring stays intact.
export const VOICE_HIDDEN = true;

// VSCode (code-server) editor — opened from a dock icon. The hosted editor
// lives at code.matrix-os.com in production; override per environment as needed.
export const VSCODE_URL = "https://code.matrix-os.com";
