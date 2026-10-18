/** Shared preview routing is tab scoped, independent of personal VPS cookies. */
export const SHARED_WORKSPACE_PREFIX = "/__shared-workspace";

export function isSharedWorkspacePath(pathname: string): boolean {
  return pathname === "/workspace" || pathname.startsWith("/workspace/")
    || pathname === SHARED_WORKSPACE_PREFIX || pathname.startsWith(`${SHARED_WORKSPACE_PREFIX}/`);
}

export type SharedRuntimeState = "sleeping" | "queued" | "starting" | "ready" | "running" | "checkpointing" | "interrupting" | "failed" | "disabled";
export function parseSharedRuntimeState(value: unknown): SharedRuntimeState {
  return typeof value === "string" && ["sleeping", "queued", "starting", "ready", "running", "checkpointing", "interrupting", "failed", "disabled"].includes(value)
    ? value as SharedRuntimeState : "failed";
}

export function sharedRuntimePresentation(state: unknown): { message: string; retry: boolean } {
  switch (parseSharedRuntimeState(state)) {
    case "sleeping": return { message: "Compute is asleep. Your saved workspace remains accessible.", retry: true };
    case "queued":
    case "starting": return { message: "Compute is starting. Your saved workspace is ready to use.", retry: false };
    case "ready": return { message: "Compute is ready.", retry: false };
    case "running": return { message: "Your agent is working. Compute stays awake until the work is saved.", retry: false };
    case "checkpointing": return { message: "Saving your work before compute sleeps.", retry: false };
    case "interrupting": return { message: "Stopping interrupted work before compute can restart.", retry: false };
    case "disabled": return { message: "Compute is disabled for this workspace. Saved data remains accessible.", retry: false };
    default: return { message: "Compute is unavailable. Your saved workspace remains accessible.", retry: true };
  }
}
