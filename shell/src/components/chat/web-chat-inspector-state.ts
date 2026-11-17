import { z } from "zod/v4";
import type { InspectorTabItem, InspectorTool } from "@matrix-os/ui";
import { parseTerminalRefKey } from "@/components/terminal/terminal-session-id";

export type Tool = Exclude<InspectorTool, "browser">;
export type Tab = InspectorTabItem & { kind: Tool };
export type SavedLayout = {
  width: number;
  treeHeight: number;
  selected: string;
  tabs: Tab[];
};
export type Session = { ref: string; name: string; cwd: string; attachable: boolean };
export const FILES: Tab = { id: "files", kind: "files", label: "Files" };
export const NEW: Tab = { id: "new-tab", kind: "new", label: "New tab" };
export const SIDE: Tab = { id: "side-chat", kind: "side-chat", label: "Side chat" };
export const MAX_TABS = 12;
export function readLayout(key: string | null, refs: readonly string[]): SavedLayout {
  const initial = {
    width: 400,
    treeHeight: 300,
    selected: "files",
    tabs: [
      FILES,
      ...refs
        .filter((ref) => parseTerminalRefKey(ref))
        .slice(0, MAX_TABS - 1)
        .map((ref) => ({
          id: `terminal:${ref}`,
          kind: "terminal" as const,
          label: "Terminal",
        })),
    ],
  };
  if (!key) return initial;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<SavedLayout> | null;
    const tabs = Array.isArray(value?.tabs)
      ? value.tabs
          .filter(
            (tab) =>
              tab &&
              ((tab.id === "files" && tab.kind === "files") ||
                (tab.id === "side-chat" && tab.kind === "side-chat") ||
                (tab.id === "new-tab" && tab.kind === "new") ||
                (tab.kind === "terminal" && tab.id.startsWith("terminal:") && parseTerminalRefKey(tab.id.slice(9)))),
          )
          .slice(0, MAX_TABS)
      : initial.tabs;
    const selected = value?.selected === "terminal" ? tabs.find((tab) => tab.kind === "terminal")?.id : value?.selected;
    return {
      width:
        typeof value?.width === "number" && Number.isFinite(value.width)
          ? Math.max(240, Math.min(820, value.width))
          : 400,
      treeHeight:
        typeof value?.treeHeight === "number" && Number.isFinite(value.treeHeight)
          ? Math.max(120, Math.min(1200, value.treeHeight))
          : 300,
      tabs: tabs.length ? tabs : [FILES],
      selected: tabs.some((tab) => tab.id === selected) ? selected! : "files",
    };
  } catch (error: unknown) {
    console.warn("[chat-inspector] Layout read unavailable:", error instanceof Error ? error.name : "UnknownError");
    return initial;
  }
}

export async function createChatTerminal(gatewayUrl: string, chatId: string, signal: AbortSignal): Promise<Session> {
  const ensured = await fetch(`${gatewayUrl}/api/terminal/workspaces/ensure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!ensured.ok) throw new Error("TerminalUnavailable");
  const workspace = z
    .object({ workspace: z.object({ id: z.string().min(1).max(128) }) })
    .parse(await ensured.json()).workspace;
  const created = await fetch(`${gatewayUrl}/api/terminal/workspaces/${encodeURIComponent(workspace.id)}/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Terminal", cwd: "", chatId }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!created.ok) throw new Error("TerminalUnavailable");
  const tab = z
    .object({
      tab: z.object({
        id: z.string().min(1).max(128),
        name: z.string().max(200).optional(),
        cwd: z.string().max(4096).optional(),
      }),
    })
    .parse(await created.json()).tab;
  return {
    ref: `${workspace.id}:${tab.id}`,
    name: tab.name ?? "Terminal",
    cwd: tab.cwd ?? "",
    attachable: true,
  };
}
export async function deleteChatTerminal(gatewayUrl: string, target: Tab, signal: AbortSignal): Promise<void> {
  const ref = parseTerminalRefKey(target.id.slice(9));
  if (!ref) throw new Error("TerminalUnavailable");
  const response = await fetch(
    `${gatewayUrl}/api/terminal/workspaces/${encodeURIComponent(ref.workspaceId)}/tabs/${encodeURIComponent(ref.tabId)}`,
    { method: "DELETE", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
  );
  if (!response.ok) throw new Error("TerminalUnavailable");
}
