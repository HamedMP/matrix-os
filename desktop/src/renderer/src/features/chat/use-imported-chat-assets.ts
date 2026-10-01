import { useCallback, useEffect, useRef } from "react";
import { ImportedChatAssetRefSchema, importedChatAssetContentPath, type ImportedChatAssetRef } from "@matrix-os/contracts";
import { savePreviewBlob } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
export function useImportedChatAssets(api: ApiClient | null | undefined, chatId?: string) {
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, [api, chatId]);
  const openImportedAsset = useCallback(async (input: ImportedChatAssetRef) => {
    const parsed = ImportedChatAssetRefSchema.safeParse(input);
    if (!api || !parsed.success || parsed.data.chatId !== chatId || active.current) throw new Error("ImportedAssetUnavailable");
    const ref = parsed.data; const controller = new AbortController(); active.current = controller;
    const generation = captureRuntimeGeneration();
    try {
      const blob = await api.getBlob(importedChatAssetContentPath(ref), { maxBytes: 64 * 1024 * 1024, timeoutMs: 30_000, signal: controller.signal });
      if (controller.signal.aborted || !isCurrentRuntimeGeneration(generation)) throw new Error("ImportedAssetUnavailable");
      const extension = blob.type === "application/pdf" ? ".pdf" : blob.type === "text/plain" ? ".txt" : blob.type === "image/png" ? ".png" : "";
      savePreviewBlob(blob, `${ref.label}${extension}`);
    } finally { if (active.current === controller) active.current = null; }
  }, [api, chatId]);
  const loadImportedImage = useCallback(async (src: string) => {
    if (!api || !chatId) throw new Error("ImportedAssetUnavailable");
    const match = /^\/api\/chats\/([^/]+)\/imports\/assets\/([^/]+)\/content$/.exec(src);
    const ref = ImportedChatAssetRefSchema.safeParse({ chatId: match?.[1], assetId: match?.[2], label: "Imported image" });
    if (!ref.success || ref.data.chatId !== chatId || importedChatAssetContentPath(ref.data) !== src) throw new Error("ImportedAssetUnavailable");
    const generation = captureRuntimeGeneration();
    const blob = await api.getBlob(src, { maxBytes: 64 * 1024 * 1024, timeoutMs: 30_000 });
    if (!isCurrentRuntimeGeneration(generation)) throw new Error("ImportedAssetUnavailable");
    return blob;
  }, [api, chatId]);
  return { openImportedAsset, loadImportedImage };
}
