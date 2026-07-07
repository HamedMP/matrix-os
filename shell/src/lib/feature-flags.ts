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

import { isSelfHostedDocument } from "./self-host-mode";

// VSCode (code-server) editor -- opened from a dock icon. Managed Matrix Cloud
// routes through code.matrix-os.com; standalone installs expose code-server on
// the same host under /code/.
export const VSCODE_URL = "https://code.matrix-os.com";

export function getCodeEditorUrl(folder?: string): string {
  const base = isSelfHostedDocument() ? "/code/" : VSCODE_URL;
  if (!folder) {
    return base;
  }
  const url = new URL(base, typeof window === "undefined" ? "https://app.matrix-os.com" : window.location.origin);
  url.searchParams.set("folder", folder);
  return isSelfHostedDocument() ? `${url.pathname}${url.search}` : url.toString();
}
