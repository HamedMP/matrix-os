import { useEffect, useMemo, useRef, useSyncExternalStore, type ClipboardEvent, type DragEvent } from "react";
import type { ApiClient } from "../../../lib/api";
import { useConnection } from "../../../stores/connection";
import { createLocalAttachmentController } from "./local-attachment-controller";

export function useConversationAttachments(
  scopeKey?: string | null,
  apiOverride?: ApiClient | null,
) {
  const connectionApi = useConnection((state) => state.api);
  const api = apiOverride === undefined ? connectionApi : apiOverride;
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const controller = useMemo(
    () => createLocalAttachmentController({ api }),
    [api, runtimeSlot, authGeneration, scopeKey],
  );
  const pendingDispose = useRef<{ controller: typeof controller; timer: number } | null>(null);
  const items = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    const pending = pendingDispose.current;
    if (pending?.controller === controller) {
      window.clearTimeout(pending.timer);
      pendingDispose.current = null;
    }
    return () => {
      const timer = window.setTimeout(() => {
        controller.dispose();
        if (pendingDispose.current?.timer === timer) pendingDispose.current = null;
      }, 0);
      pendingDispose.current = { controller, timer };
    };
  }, [controller]);

  const addDroppedFiles = (dataTransfer: DataTransfer) => {
    const transferItems = Array.from(dataTransfer.items ?? []);
    if (transferItems.length === 0) {
      controller.add(Array.from(dataTransfer.files ?? []));
      return;
    }
    const files = transferItems.flatMap((item) => {
      if (item.kind !== "file") return [];
      const entry = (item as DataTransferItem & {
        webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
      }).webkitGetAsEntry?.();
      if (entry?.isDirectory) return [];
      const file = item.getAsFile();
      return file ? [file] : [];
    });
    controller.add(files);
  };

  const paneProps = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const files = Array.from(event.dataTransfer.items ?? []).some((item) => item.kind === "file")
        || (event.dataTransfer.files?.length ?? 0) > 0;
      if (!files) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const hasFiles = Array.from(event.dataTransfer.items ?? []).some((item) => item.kind === "file")
        || (event.dataTransfer.files?.length ?? 0) > 0;
      if (!hasFiles) return;
      event.preventDefault();
      addDroppedFiles(event.dataTransfer);
    },
    onPaste: (event: ClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      controller.add(files);
    },
  };

  return {
    items,
    add: controller.add,
    remove: controller.remove,
    retry: controller.retry,
    uploadAll: controller.uploadAll,
    clear: controller.clear,
    paneProps,
  };
}
