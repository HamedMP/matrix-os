import { invoke } from "../../lib/operator";
import type { ApiClient } from "../../lib/api";
import { parseTerminalRefKey } from "../../lib/terminal-workspaces";
import { LOCAL_TERMINAL_SESSION_PREFIX, LocalTerminalIdSchema, LOCAL_TERMINAL_PUT_MAX_BYTES } from "../../../../shared/local-terminals";
import { safeTerminalUploadFilename } from "./terminal-rich-paste";

/** Both transports return a path on the terminal's machine, never an app-host path. */
export async function putTerminalPasteFile(input: {
  sessionName: string; api: ApiClient | null; name: string; mimeType: string;
  dataBase64: string; size: number; kind: "image" | "file";
}): Promise<string> {
  let name = safeTerminalUploadFilename(input.name);
  let path: unknown;
  if (input.sessionName.startsWith(LOCAL_TERMINAL_SESSION_PREFIX)) {
    name = name.replace(/[^A-Za-z0-9._ -]/g, "-").slice(0, 128);
    const id = LocalTerminalIdSchema.parse(input.sessionName.slice(LOCAL_TERMINAL_SESSION_PREFIX.length));
    if (input.size > LOCAL_TERMINAL_PUT_MAX_BYTES) throw new Error("Local paste file too large");
    const result = await invoke("local-terminal:put", { id, name, dataBase64: input.dataBase64 });
    if (!result.ok) throw new Error("Local paste failed");
    path = result.path;
  } else {
    const ref = parseTerminalRefKey(input.sessionName);
    if (!input.api || !ref) throw new Error("Terminal paste unavailable");
    const response = await input.api.post<{ assets?: Array<{ terminalPath?: string }> }>(
      `/api/terminal/workspaces/${encodeURIComponent(ref.workspaceId)}/tabs/${encodeURIComponent(ref.tabId)}/paste-assets`,
      { ...(input.kind === "file" ? { kind: input.kind } : {}), assets: [{ name, mimeType: input.mimeType, dataBase64: input.dataBase64 }] },
      { timeoutMs: 30_000 },
    );
    path = response.assets?.[0]?.terminalPath;
    if (typeof path !== "string" || !path.startsWith("/home/matrix/home/")) throw new Error("Invalid cloud paste path");
  }
  if (typeof path !== "string" || !path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("Invalid paste path");
  return path;
}
