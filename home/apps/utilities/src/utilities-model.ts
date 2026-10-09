export interface UtilityTool {
  slug: string;
  title: string;
  description: string;
  example: string;
  howTo: string;
  limitations: string;
  category: string;
  mode: string;
}

export const MAX_SEARCH_LENGTH = 160;
export function filterTools(tools: readonly UtilityTool[], search: string, category: string) {
  const query = search.slice(0, MAX_SEARCH_LENGTH).trim().toLocaleLowerCase();
  return tools.filter((tool) => (category === "All" || tool.category === category) &&
    `${tool.title} ${tool.description} ${tool.category}`.toLocaleLowerCase().includes(query));
}

export type WorkspaceKind = "text" | "pdf" | "pdf-podcast" | "pdf-signature" | "image" | "audio" | "extra" | "editor" | "collaboration" | "workflow" | "local-ai";
export function workspaceKind(tool: UtilityTool): WorkspaceKind | null {
  if (tool.slug === "pdf-podcast") return "pdf-podcast";
  if (tool.slug === "check-pdf-signature") return "pdf-signature";
  switch (tool.mode) {
    case "text": case "pdf": case "image": case "audio": case "extra": case "editor": case "collaboration": case "workflow": case "local-ai": return tool.mode;
    default: return null;
  }
}

export function needsModelDownload(tool: UtilityTool): boolean {
  return tool.mode === "local-ai" || tool.slug === "pdf-podcast" || /download.{0,25}(model|runtime)|downloads.{0,25}MB/i.test(tool.limitations);
}

export function processingNotice(tool: UtilityTool): string {
  if (tool.mode === "collaboration") return "Peer connection · Files and calls go to the peer you connect. A public STUN service sees connection metadata. Both devices must stay connected.";
  if (tool.slug === "pdf-podcast") return "On your device · Voice models download when needed. Review generated speech and keep the workspace open until processing finishes.";
  if (needsModelDownload(tool)) return "On your device · First use downloads a model or browser runtime. Your input is processed on this device. Check the tool’s limits before downloading.";
  return "On your device · Input stays in this workspace. Open files from your device and save results with Download. Work here is temporary; download results before leaving.";
}

export interface NavigationState { active: string | null; dirty: boolean; pending: string | null | undefined }
export const initialNavigation: NavigationState = { active: null, dirty: false, pending: undefined };
export type NavigationAction = { type: "open"; slug: string | null } | { type: "dirty" } | { type: "cancel" } | { type: "discard" };
export function navigationReducer(state: NavigationState, action: NavigationAction): NavigationState {
  switch (action.type) {
    case "dirty": return state.active ? { ...state, dirty: true } : state;
    case "cancel": return { ...state, pending: undefined };
    case "discard": return state.pending === undefined ? state : { active: state.pending, dirty: false, pending: undefined };
    case "open":
      if (action.slug === state.active) return state;
      return state.active && state.dirty ? { ...state, pending: action.slug } : { active: action.slug, dirty: false, pending: undefined };
  }
}
