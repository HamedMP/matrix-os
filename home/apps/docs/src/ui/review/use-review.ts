/**
 * React hooks of the review UI: one `ReviewController` per session, its
 * snapshot as state, the keyboard shortcuts, and clicks on commented text.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import type { DocumentEditorController } from "../../editor/types";
import { ReviewController, type ReviewSnapshot, threadOfComment } from "../../review/index";
import type { DocumentSession } from "../../session/index";

/**
 * A review controller for the session, connected to the editor once it is
 * mounted. Null during the first render; a new session makes a new controller.
 */
export function useReviewController(session: DocumentSession, editor: DocumentEditorController | null): ReviewController | null {
  const [controller, setController] = useState<ReviewController | null>(null);
  useEffect(() => {
    const created = new ReviewController(session);
    setController(created);
    return () => {
      created.dispose();
      setController((current) => (current === created ? null : current));
    };
  }, [session]);
  useEffect(() => {
    if (controller === null) return undefined;
    controller.attachEditor(editor);
    return () => controller.attachEditor(null);
  }, [controller, editor]);
  return controller;
}

export function useReviewSnapshot(controller: ReviewController): ReviewSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}

/**
 * Alt+Shift+N/P/A/R/M anywhere in the window (or in `target`): next,
 * previous, accept, reject, comment. Listens in the capture phase so the
 * editor never turns the key into text.
 */
export function useReviewShortcuts(controller: ReviewController | null, target?: HTMLElement | Window | null): void {
  useEffect(() => {
    if (controller === null) return undefined;
    const element = target === undefined ? window : target;
    if (element === null) return undefined;
    const onKeyDown = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.defaultPrevented || key.isComposing) return;
      if (controller.handleShortcut(key)) {
        key.preventDefault();
        key.stopPropagation();
      }
    };
    element.addEventListener("keydown", onKeyDown, true);
    return () => element.removeEventListener("keydown", onKeyDown, true);
  }, [controller, target]);
}

/**
 * The element that hosts the editor's DOM (`.doc-editor-host`), found from a
 * rendered block, for listeners that watch pointer events over the document.
 * Null while no document is shown.
 */
export function useEditorSurface(editor: DocumentEditorController | null, session: DocumentSession): HTMLElement | null {
  const documentKey = useSyncExternalStore(session.subscribe, () => session.getState().documentKey);
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const first = session.document?.getView().body.blocks[0]?.id;
    const block = editor === null || first === undefined ? null : editor.getBlockElement(first);
    const host = block === null ? null : (block.closest<HTMLElement>(".doc-editor-host") ?? block.parentElement);
    setSurface(host);
  }, [editor, session, documentKey]);
  return surface;
}

/** Clicking commented text in the document makes its thread active. */
export function useCommentClicks(controller: ReviewController | null, container: HTMLElement | null): void {
  useEffect(() => {
    if (controller === null || container === null) return undefined;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("[data-comment-ids]") : null;
      if (target === null || !container.contains(target)) return;
      const ids = (target.getAttribute("data-comment-ids") ?? "").split(/\s+/).filter(Boolean);
      const threads = controller.getSnapshot().threads;
      // The innermost comment is listed last.
      for (let at = ids.length - 1; at >= 0; at--) {
        const thread = threadOfComment(threads, ids[at]!);
        if (thread === null) continue;
        if (controller.getSnapshot().activeThread?.id !== thread.id) controller.selectThread(thread.id, { scroll: false });
        return;
      }
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [controller, container]);
}
