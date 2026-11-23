/**
 * `<DocumentEditor>`: the React face of the editor. React renders one host
 * element and never touches what is inside it; the editor core owns that DOM.
 */

import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { DocumentSession, SessionState } from "../session/index";
import { EditorCore } from "./editor-core";
import "./editor.css";
import type { DocumentEditorController, DocumentEditorOptions, EditorSelection, EditorSnapshot, ViewMode } from "./types";

export interface DocumentEditorProps {
  /** The session whose document is edited. A new session remounts the editor. */
  session: DocumentSession;
  /** Controls the view mode. Without it the editor starts in `markup` and `controller.setViewMode` changes it. */
  viewMode?: ViewMode;
  readOnly?: boolean;
  className?: string;
  /** Accessible name of the editing surface. Default `Document`. */
  ariaLabel?: string;
  /** Receives the imperative controller while the editor is mounted. */
  ref?: Ref<DocumentEditorController>;
  /** Called once per mount with the controller. */
  onReady?: (controller: DocumentEditorController) => void;
  onSelectionChange?: (selection: EditorSelection | null) => void;
  /** Called for Ctrl/Cmd+click on a link. Default: open it in a new window. */
  onOpenLink?: (href: string) => void;
}

export function DocumentEditor(props: DocumentEditorProps) {
  const { session, viewMode, readOnly = false, className, ariaLabel, ref, onReady, onSelectionChange, onOpenLink } = props;
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onSelectionChange, onOpenLink });
  useEffect(() => {
    callbacks.current = { onReady, onSelectionChange, onOpenLink };
  });

  const initial = useRef({ viewMode, readOnly });
  const core = useMemo(() => {
    const options: DocumentEditorOptions = {
      ariaLabel,
      // Starting values; the effects below follow later changes of the props.
      viewMode: initial.current.viewMode,
      readOnly: initial.current.readOnly,
      onOpenLink: (href) => {
        const open = callbacks.current.onOpenLink;
        if (open !== undefined) open(href);
        else window.open(href, "_blank", "noopener,noreferrer");
      },
    };
    return new EditorCore(session, options);
    // The accessible name is read once per editor; a new session makes a new editor.
  }, [session, ariaLabel]);

  // Mounted in the layout phase, before the ref is handed out below, so the
  // controller a parent receives is already showing the document.
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null) return undefined;
    core.mount(element);
    return () => core.unmount();
  }, [core]);

  useImperativeHandle(ref, () => core, [core]);

  useEffect(() => {
    const stop = core.onSelectionChange((selection) => callbacks.current.onSelectionChange?.(selection));
    callbacks.current.onReady?.(core);
    return stop;
  }, [core]);

  useEffect(() => {
    if (viewMode !== undefined) core.setViewMode(viewMode);
  }, [core, viewMode]);

  useEffect(() => {
    core.setReadOnly(readOnly);
  }, [core, readOnly]);

  return <div ref={host} className={className === undefined ? "doc-editor-host" : `doc-editor-host ${className}`} />;
}

const NO_SNAPSHOT: EditorSnapshot = Object.freeze({ viewMode: "markup", readOnly: true, focused: false, selection: null, activeFormat: null });
const noSubscription = (): (() => void) => () => undefined;

/** The editor's snapshot (view mode, selection, active formatting) as React state. Accepts null before the editor is ready. */
export function useEditorSnapshot(controller: DocumentEditorController | null): EditorSnapshot {
  return useSyncExternalStore(controller === null ? noSubscription : controller.subscribe, controller === null ? () => NO_SNAPSHOT : controller.getSnapshot);
}

/** The session state (dirty, save status, conflict, tracking, undo availability) as React state. */
export function useSessionState(session: DocumentSession): SessionState {
  return useSyncExternalStore(session.subscribe, session.getState);
}
