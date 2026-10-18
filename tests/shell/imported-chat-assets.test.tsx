// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useImportedChatAssets } from "../../shell/src/components/chat/useImportedChatAssets";
import { savePreviewBlob } from "@matrix-os/ui";
vi.mock("@matrix-os/ui", async original => ({ ...await original<typeof import("@matrix-os/ui")>(), savePreviewBlob: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const ref = { chatId: "chat_history", assetId: "019eb0ae-9a30-7541-bdb8-db4d17e65146", label: "Full tool input" };
it("fetches only validated assets of the selected Chat through the gateway", async () => {
  const fetchFn = vi.fn(async () => new Response("saved input", { headers: { "content-type": "text/plain" } }));
  vi.stubGlobal("fetch", fetchFn);
  const hook = renderHook(() => useImportedChatAssets(ref.chatId, "owner_a"));
  await expect(hook.result.current.openImportedAsset({ ...ref, chatId: "chat_other" })).rejects.toThrow();
  expect(fetchFn).not.toHaveBeenCalled();
  await hook.result.current.openImportedAsset(ref);
  expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining(`/api/chats/${ref.chatId}/imports/assets/${ref.assetId}/content`), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(savePreviewBlob).toHaveBeenCalledWith(expect.any(Blob), "Full tool input.txt");
  hook.unmount();
});
it("does not finish a download after switching owner with the same Chat id", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(r => { resolve = r; })));
  const hook = renderHook(({ owner }) => useImportedChatAssets(ref.chatId, owner), { initialProps: { owner: "owner_a" } });
  const pending = hook.result.current.openImportedAsset(ref);
  hook.rerender({ owner: "owner_b" });
  resolve(new Response("private input"));
  await expect(pending).rejects.toThrow("ImportedAssetUnavailable");
  expect(savePreviewBlob).not.toHaveBeenCalled();
  hook.unmount();
});
