import { useLayoutEffect, useRef, useState } from "react";
import { FileResourceRefSchema } from "@matrix-os/contracts";

import type { ChatAttachmentKind, ComposerAttachment } from "@/lib/chat-attachments";
import { discardMatrixAttachment, stageMatrixAttachment } from "@/lib/matrix-attachment";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { useComputerDirectory } from "@/lib/queries/use-computer-directory";
import type { FileEntry } from "@/lib/requests/files";

import { MatrixAttachmentPickerView } from "./MatrixAttachmentPickerView";

export interface MatrixAttachmentBinding {
  scope: string;
  gatewayUrl: string;
}

export function MatrixAttachmentPicker({ binding, kinds, room, attachments, onBack, onAdd }: {
  binding: MatrixAttachmentBinding;
  kinds: readonly ChatAttachmentKind[];
  room: number;
  attachments: readonly ComposerAttachment[];
  onBack: () => void;
  onAdd: (attachment: ComposerAttachment) => void;
}) {
  const [path, setPath] = useState("");
  const { entries, isPending, isError, refresh, computer } = useComputerDirectory(path);
  const gateway = useActiveGateway();
  const request = useRef<AbortController | null>(null);
  const [readingPath, setReadingPath] = useState<string | null>(null);
  const pending = readingPath !== null;
  const [error, setError] = useState<string | null>(null);
  const kindsKey = kinds.join(",");
  const ready = gateway.ready && gateway.gatewayUrl === binding.gatewayUrl
    && computer?.gatewayPath === gateway.computer?.gatewayPath;
  useLayoutEffect(() => () => { request.current?.abort(); }, [
    binding.scope, binding.gatewayUrl, gateway.userId, ready, room, kindsKey,
  ]);

  async function select(fullPath: string) {
    if (!ready || room <= 0 || request.current) return;
    if (attachments.some(({ matrixSource: source }) => (
      source?.path === fullPath && source.gatewayUrl === binding.gatewayUrl && source.userId === gateway.userId
    ))) {
      setError("This Matrix file is already attached.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setReadingPath(fullPath);
    setError(null);
    try {
      const session = await gateway.session();
      if (controller.signal.aborted) return;
      if (!session || session.gatewayUrl !== binding.gatewayUrl) throw new Error("MatrixAttachmentUnavailable");
      const attachment = await stageMatrixAttachment({
        gatewayUrl: binding.gatewayUrl, userId: gateway.userId, path: fullPath,
      }, session.token, kinds, controller.signal);
      if (controller.signal.aborted) discardMatrixAttachment(attachment);
      else onAdd(attachment);
    } catch (cause: unknown) {
      if (!controller.signal.aborted) {
        const code = cause instanceof Error ? cause.message : "";
        setError(code === "MatrixAttachmentTooLarge" ? "This Matrix file exceeds the attachment size limit."
          : code === "MatrixAttachmentUnsupported" ? "The selected model cannot read this file."
            : "Could not read this Matrix file. Try again.");
      }
    } finally {
      request.current = null;
      setReadingPath(null);
    }
  }

  function openEntry(item: FileEntry) {
    const next = path ? `${path}/${item.name}` : item.name;
    if (!FileResourceRefSchema.safeParse({ kind: "home", path: next }).success) return;
    if (item.type === "directory") { setError(null); setPath(next); }
    else void select(next);
  }

  return <MatrixAttachmentPickerView
    path={path} entries={entries} loading={isPending} unavailable={isError || !ready}
    error={error} readingPath={readingPath} room={room} onSelect={openEntry}
    onBack={() => {
      if (!path) { request.current?.abort(); onBack(); }
      else if (!pending) { setError(null); setPath(path.split("/").slice(0, -1).join("/")); }
    }}
    onHome={() => { if (!pending) { setError(null); setPath(""); } }}
    onRetry={() => { void refresh(); }}
  />;
}
