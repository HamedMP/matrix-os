import { useLayoutEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { Button, Dialog } from "../../../design/primitives";
import type { ApiClient } from "../../../lib/api";
import { useConnection } from "../../../stores/connection";
import { InspectorFilesPanel } from "../../panels/InspectorFilesPanel";
import type { WorkFilesScope } from "../../work/work-files-scope";
import { MAX_ATTACHMENTS } from "./local-attachment-controller";
import {
  MATRIX_FILE_DRAG_TYPE,
  captureAttachmentConnection,
  readMatrixFileAttachment,
  takeMatrixFileDrag,
  type MatrixAttachmentResource,
} from "./matrix-file-attachment";
import type { useConversationAttachments } from "./use-conversation-attachments";

export function useMatrixAttachmentControls({
  api, scopeKey, project, enabled, locked, queue, deviceInput, validate,
}: {
  api: ApiClient | null;
  scopeKey: string;
  project?: Extract<WorkFilesScope, { kind: "project" }>;
  enabled: boolean;
  locked: boolean;
  queue: ReturnType<typeof useConversationAttachments>;
  deviceInput: RefObject<HTMLInputElement | null>;
  validate: (files: readonly File[]) => string | null;
}) {
  const slot = useConnection(state => state.runtimeSlot);
  const authGeneration = useConnection(state => state.authGeneration);
  const identity = JSON.stringify([slot, authGeneration, scopeKey, project?.projectId, project?.worktreeId]);
  const [picker, setPicker] = useState<{ identity: string; source: "project" | "home" } | null>(null);
  const [notice, setNotice] = useState<{ identity: string; message: string } | null>(null);
  const [pendingIdentity, setPendingIdentity] = useState<string | null>(null);
  const pending = pendingIdentity === identity;
  const currentPicker = enabled && api && picker?.identity === identity ? picker : null;
  const current = useRef({ api, identity, enabled, locked, queue, validate });
  const read = useRef<AbortController | null>(null);
  useLayoutEffect(() => { current.current = { api, identity, enabled, locked, queue, validate }; });
  useLayoutEffect(() => () => {
    read.current?.abort();
    read.current = null;
    setPendingIdentity(null);
  }, [api, identity, enabled]);

  const close = () => {
    read.current?.abort();
    setPicker(null);
  };
  const report = (message: string) => setNotice({ identity, message });
  const attach = async (resource: MatrixAttachmentResource) => {
    if (!api || !enabled || locked || read.current) return;
    const resourceKey = JSON.stringify([resource.kind, resource.kind === "project" && resource.projectId,
      resource.kind === "project" && resource.worktreeId, resource.path]);
    const controller = new AbortController();
    const connection = captureAttachmentConnection();
    const assertCapacity = (items: typeof queue.items) => {
      if (items.some(item => item.matrixResourceKey === resourceKey)) return "This Matrix file is already attached.";
      if (items.length >= MAX_ATTACHMENTS) return `You can attach up to ${MAX_ATTACHMENTS} files.`;
      return null;
    };
    const initialError = assertCapacity(queue.items);
    if (initialError) { report(initialError); return; }
    setNotice(null);
    read.current = controller;
    setPendingIdentity(identity);
    const isCurrent = () => connection.isCurrent() && current.current.api === api && current.current.identity === identity
      && current.current.enabled && !current.current.locked && !controller.signal.aborted;
    try {
      const file = await readMatrixFileAttachment(api.forRuntime(connection.runtimeSlot), resource, controller.signal);
      if (!isCurrent()) return;
      const active = current.current;
      const error = assertCapacity(active.queue.items) ?? active.validate([...active.queue.items.map(item => item.file), file]);
      if (error) { report(error); return; }
      active.queue.add([file], resourceKey);
      setPicker(null);
    } catch (error: unknown) {
      if (isCurrent()) report(error instanceof Error && error.message === "file_too_large"
        ? "Files are limited to 10 MiB."
        : "Could not read that Matrix file. Check that it still exists and try again.");
    } finally {
      if (read.current === controller) {
        read.current = null;
        setPendingIdentity(null);
      }
    }
  };
  const onAttach = () => {
    if (locked) return;
    if (!api || !enabled) { deviceInput.current?.click(); return; }
    setNotice(null);
    setPicker({ identity, source: project ? "project" : "home" });
  };
  const hasMatrixDrag = (event: DragEvent<HTMLElement>) => event.dataTransfer.types?.includes(MATRIX_FILE_DRAG_TYPE) ?? false;
  const paneProps = {
    ...queue.paneProps,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!hasMatrixDrag(event)) { queue.paneProps.onDragOver(event); return; }
      if (!enabled || locked || pending) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!hasMatrixDrag(event)) { queue.paneProps.onDrop(event); return; }
      event.preventDefault();
      event.stopPropagation();
      if (!enabled || locked || pending) return;
      const resource = takeMatrixFileDrag(event.dataTransfer);
      if (resource) void attach(resource);
      else report("Drag the file again from the current Matrix computer.");
    },
  };
  const error = notice?.identity === identity ? notice.message : null;
  const dialog = currentPicker ? (
    <Dialog open onClose={close} title="Attach files" placement="center" width={560}>
      <div className="flex flex-wrap gap-2">
        <Button variant="subtle" disabled={pending} onClick={() => { close(); deviceInput.current?.click(); }}>Choose from this device</Button>
        {project ? <>
          <Button variant="subtle" disabled={pending} aria-pressed={currentPicker.source === "project"}
            onClick={() => setPicker({ identity, source: "project" })}>Project files</Button>
          <Button variant="subtle" disabled={pending} aria-pressed={currentPicker.source === "home"}
            onClick={() => setPicker({ identity, source: "home" })}>Matrix home</Button>
        </> : null}
      </div>
      {!project ? <p className="mt-4 text-sm font-medium">Matrix files</p> : null}
      <div role="group" aria-label="Matrix files" className="mt-2 flex h-[min(45vh,360px)] min-h-0 flex-col overflow-hidden rounded-lg border">
        <InspectorFilesPanel
          browserOnly attachmentPicker
          scope={currentPicker.source === "project" && project ? project : { kind: "home", chatId: "attachment-picker" }}
          onOpenFile={target => {
            const { label: _label, ...resource } = target;
            void attach(resource);
          }}
        />
      </div>
      {pending ? <p role="status" className="mt-2 text-sm">Reading Matrix file…</p> : null}
      {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
      <div className="mt-4 flex justify-end"><Button variant="subtle" onClick={close}>Cancel</Button></div>
    </Dialog>
  ) : null;
  return { onAttach, paneProps, dialog, pending, error: currentPicker ? null : error };
}
