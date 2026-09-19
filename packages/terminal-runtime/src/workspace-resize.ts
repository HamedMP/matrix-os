import { TerminalGridSizeSchema, type TerminalRef, type TerminalWorkspace } from "@matrix-os/contracts";

export interface TerminalSizeListener {
  onDisconnect?: () => void | Promise<void>;
  onCanonicalSize?: (size: { cols: number; rows: number }, revision: number) => void | Promise<void>;
}
interface ResizeViewer extends TerminalSizeListener {
  id: string;
  requestedSize?: { cols: number; rows: number };
  disposeOutput(): void;
}
interface ResizeAttachment {
  ref: TerminalRef;
  handle: { resize(cols: number, rows: number): Promise<void> };
  viewers: Map<string, ResizeViewer>;
}

/** Runs under the runtime's workspace mutation queue, including PTY application and notification. */
export async function applyWorkspaceResize(options: {
  workspace: TerminalWorkspace;
  resizeSession(): Promise<void>;
  attachments: Iterable<ResizeAttachment>;
  closeEmpty(ref: TerminalRef): Promise<void>;
}): Promise<void> {
  const { workspace } = options;
  await options.resizeSession();
  const failures: unknown[] = [];
  for (const attachment of options.attachments) {
    if (attachment.ref.workspaceId !== workspace.id) continue;
    try {
      await attachment.handle.resize(workspace.canonicalSize.cols, workspace.canonicalSize.rows);
    } catch (error: unknown) {
      failures.push(error);
      console.error("[terminal-runtime] attachment resize failed", error instanceof Error ? error.name : "unknown_error");
      for (const viewer of attachment.viewers.values()) {
        viewer.disposeOutput();
        try { await viewer.onDisconnect?.(); }
        catch (disconnectError: unknown) {
          console.error("[terminal-runtime] viewer disconnect failed", disconnectError instanceof Error ? disconnectError.name : "unknown_error");
        }
      }
      attachment.viewers.clear();
      try { await options.closeEmpty(attachment.ref); }
      catch (closeError: unknown) { failures.push(closeError); }
      continue;
    }
    const failed: ResizeViewer[] = [];
    for (const viewer of attachment.viewers.values()) {
      try {
        await viewer.onCanonicalSize?.(workspace.canonicalSize, workspace.revision);
      } catch (error: unknown) {
        console.error("[terminal-runtime] viewer size send failed", error instanceof Error ? error.name : "unknown_error");
        failed.push(viewer);
      }
    }
    for (const viewer of failed) {
      viewer.disposeOutput();
      if (attachment.viewers.get(viewer.id) === viewer) attachment.viewers.delete(viewer.id);
    }
    if (attachment.viewers.size === 0) await options.closeEmpty(attachment.ref);
  }
  if (failures.length > 0) throw new AggregateError(failures, "Terminal attachment resize failed");
}

/** Live hard clients share one grid; a smaller tab cannot shrink another writer's viewport. */
export function workspaceResizeProposal(options: {
  ref: TerminalRef;
  size: { cols: number; rows: number };
  viewerId?: string;
  mode: "hard" | "soft";
  attachments: Iterable<ResizeAttachment>;
}): { cols: number; rows: number } | undefined {
  const requested = options.mode === "hard" ? TerminalGridSizeSchema.parse(options.size) : undefined;
  const attachments = [...options.attachments].filter((item) => item.ref.workspaceId === options.ref.workspaceId);
  if (options.viewerId) {
    const viewer = attachments.find((item) => item.ref.tabId === options.ref.tabId)?.viewers.get(options.viewerId);
    if (!requested) {
      if (!viewer?.requestedSize) return undefined;
      delete viewer.requestedSize;
    } else {
      if (!viewer) throw new Error("Terminal resize viewer unavailable");
      viewer.requestedSize = requested;
    }
  }
  let size = requested ? { ...requested } : undefined;
  for (const attachment of attachments) {
    for (const viewer of attachment.viewers.values()) {
      if (!viewer.requestedSize) continue;
      size ??= { ...viewer.requestedSize };
      size.cols = Math.max(size.cols, viewer.requestedSize.cols);
      size.rows = Math.max(size.rows, viewer.requestedSize.rows);
    }
  }
  return size;
}
