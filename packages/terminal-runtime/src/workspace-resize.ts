import type { TerminalRef, TerminalWorkspace } from "@matrix-os/contracts";

export interface TerminalSizeListener {
  onCanonicalSize?: (size: { cols: number; rows: number }, revision: number) => void | Promise<void>;
}
interface ResizeViewer extends TerminalSizeListener {
  id: string;
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
