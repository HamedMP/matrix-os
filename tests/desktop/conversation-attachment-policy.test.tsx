// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useConversationAttachments } from "../../desktop/src/renderer/src/features/chat/attachments/use-conversation-attachments";

it("uses the current policy on failed-upload Retry without losing the selected file", async () => {
  const putBytes = vi.fn().mockRejectedValue(new Error("offline"));
  const api = { putBytes } as never;
  const hook = renderHook(({ error }: { error: string | null }) => useConversationAttachments("chat_current", api, () => error), { initialProps: { error: null as string | null } });
  const file = new File(["input"], "file.bin", { type: "application/octet-stream" });
  act(() => hook.result.current.add([file]));
  await act(async () => { await hook.result.current.uploadAll(); });
  const localId = hook.result.current.items[0]!.localId;
  hook.rerender({ error: "The selected provider does not support file attachments." });
  await act(async () => { await hook.result.current.retry(localId); });
  expect(putBytes).toHaveBeenCalledOnce();
  expect(hook.result.current.items[0]).toMatchObject({ localId, file, status: "failed", error: "The selected provider does not support file attachments." });
  hook.rerender({ error: null });
  putBytes.mockImplementation(async (url: string, bytes: File) => ({ path: decodeURIComponent(url.split("path=")[1]!), size: bytes.size }));
  await act(async () => { await hook.result.current.retry(localId); });
  expect(putBytes).toHaveBeenCalledTimes(2); expect(hook.result.current.items[0]!.status).toBe("ready");
  hook.unmount();
});
