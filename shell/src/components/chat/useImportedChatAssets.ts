"use client";
import { useCallback, useEffect, useRef } from "react";
import { ImportedChatAssetRefSchema, importedChatAssetContentPath, type ImportedChatAssetRef } from "@matrix-os/contracts";
import { savePreviewBlob } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { readBoundedChatBlob } from "./ChatFilePanel";

export function useImportedChatAssets(chatId?: string, authorityKey?: string) {
  const live = useRef({ chatId, authorityKey, generation: 0 });
  if (live.current.chatId !== chatId || live.current.authorityKey !== authorityKey) live.current.generation += 1;
  const generation = live.current.generation;
  live.current = { chatId, authorityKey, generation };
  const active = useRef<AbortController | null>(null);
  const images = useRef(new Set<AbortController>()); // At most 16 concurrent requests, removed on settlement or scope change.
  useEffect(() => () => {
    live.current.generation += 1; active.current?.abort(); active.current = null;
    for (const controller of images.current) controller.abort(); images.current.clear();
  }, [chatId, authorityKey]);
  const load = useCallback(async (input: ImportedChatAssetRef, signal?: AbortSignal) => {
    const requestGeneration = live.current.generation;
    const ref = ImportedChatAssetRefSchema.parse(input);
    if (ref.chatId !== chatId || live.current.chatId !== chatId || live.current.authorityKey !== authorityKey) throw new Error("ImportedAssetUnavailable");
    const response = await fetch(`${getGatewayUrl()}${importedChatAssetContentPath(ref)}`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    const blob = await readBoundedChatBlob(response, 64 * 1024 * 1024);
    if (live.current.chatId !== chatId || live.current.generation !== requestGeneration || signal?.aborted) throw new Error("ImportedAssetUnavailable");
    return blob;
  }, [chatId, authorityKey]);
  const openImportedAsset = useCallback(async (ref: ImportedChatAssetRef) => {
    if (active.current) throw new Error("ImportedAssetUnavailable");
    const controller = new AbortController(); active.current = controller;
    try { const blob = await load(ref, controller.signal); savePreviewBlob(blob, `${ref.label}${blob.type === "text/plain" ? ".txt" : ""}`); }
    finally { if (active.current === controller) active.current = null; }
  }, [load]);
  const loadImportedImage = useCallback(async (src: string) => {
    const match = /^\/api\/chats\/([^/]+)\/imports\/assets\/([^/]+)\/content$/.exec(src);
    const ref = ImportedChatAssetRefSchema.parse({ chatId: match?.[1], assetId: match?.[2], label: "Imported image" });
    if (importedChatAssetContentPath(ref) !== src) throw new Error("ImportedAssetUnavailable");
    if (images.current.size >= 16) throw new Error("ImportedAssetUnavailable");
    const controller = new AbortController(); images.current.add(controller);
    try { return await load(ref, controller.signal); }
    finally { images.current.delete(controller); }
  }, [load]);
  return { openImportedAsset, loadImportedImage };
}
