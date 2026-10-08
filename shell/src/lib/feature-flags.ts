// Shell feature flags — flip to re-enable a surface.
//
// Chat is a first-class shell destination. Keep the visibility switch explicit
// so emergency rollbacks can hide its launchers without removing `__chat__`
// routing or persisted windows.
export const HERMES_CHAT_HIDDEN = false;

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
