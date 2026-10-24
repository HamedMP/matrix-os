import { act, renderHook } from "@testing-library/react-native";

import { useChatComposer } from "../lib/use-chat-composer";
import { useProjectComposer } from "../components/projects/use-project-composer";
import { attachment, attachmentCatalog, managedSelection, MiB } from "./attachment-policy-fixtures";

const mockMutate = jest.fn();
jest.mock("@/lib/queries/use-send-chat-message", () => ({
  useSendChatMessage: () => ({ mutate: mockMutate, isPending: false }),
}));

type Options = Parameters<typeof useChatComposer>[0];

function renderComposer(selection = managedSelection) {
  const initialProps = {
    scope: "user:computer", activeChatId: "chat_a", detail: null, projectId: null,
    selection, catalog: attachmentCatalog(), turnModes: { interactionMode: "default", permissionMode: "supervised" },
    attachmentKinds: ["image", "file"],
  } as Options;
  const hook = renderHook((props: Options) => useChatComposer(props), { initialProps });
  return { ...hook, initialProps };
}

beforeEach(() => jest.clearAllMocks());

it.each([
  ["GIF", [attachment({ mimeType: "image/gif" })], "Use PNG, JPEG or WebP"],
  ["large file", [attachment({ kind: "file", sizeBytes: 10 * MiB + 1 })], "Files must be 10 MiB"],
  ["combined file total", [attachment({ kind: "file", sizeBytes: 10 * MiB }), attachment({ id: "att_second", kind: "file", sizeBytes: 10 * MiB }), attachment({ id: "att_extra", kind: "file", sizeBytes: 1 })], "total 20 MiB"],
  ["large image", [attachment({ sizeBytes: 2 * MiB + 1 })], "Images must be 2 MiB"],
  ["five images", Array.from({ length: 5 }, (_, index) => attachment({ id: `att_${index}` })), "up to four images"],
  ["funded total", [attachment({ sizeBytes: MiB + 1 })], "total 1 MiB"],
])("preserves draft and attachments before any upload or optimistic send for %s", (_case, parts, error) => {
  const { result } = renderComposer();
  act(() => { result.current.setDraft("  Keep this draft "); result.current.addAttachments(parts); });

  expect(result.current.canSend).toBe(false);
  expect(result.current.attachmentNotice).toContain(error);
  act(() => result.current.send());

  expect(mockMutate).not.toHaveBeenCalled();
  expect(result.current.draft).toBe("  Keep this draft ");
  expect(result.current.attachments).toEqual(parts);
  expect(result.current.optimisticMessages).toEqual([]);
});

it("revalidates against the current model and allows editing or removing a rejected attachment", () => {
  const { result, rerender, initialProps } = renderComposer();
  act(() => { result.current.setDraft("Keep this"); result.current.addAttachments([attachment()]); });
  expect(result.current.canSend).toBe(true);

  rerender({ ...initialProps, selection: { ...managedSelection, model: "text" } });
  expect(result.current.canSend).toBe(false);
  expect(result.current.attachmentNotice).toBe("The selected model does not support images.");
  act(() => { result.current.setDraft("Edited draft"); result.current.send(); });
  expect(mockMutate).not.toHaveBeenCalled();
  expect(result.current.draft).toBe("Edited draft");

  act(() => result.current.removeAttachment(attachment().id));
  expect(result.current.canSend).toBe(true);
  expect(result.current.attachmentNotice).toBeNull();
  act(() => result.current.send());
  expect(mockMutate).toHaveBeenCalledWith(expect.objectContaining({ text: "Edited draft", attachments: [] }), expect.anything());
});

it("checks failed-message retries with current instance/model/options, keeping Edit and idempotency keys", () => {
  const selection = { instanceId: "matrix_bot_default", model: "vision", options: [{ id: "source", value: "own" }] };
  const { result, rerender, initialProps } = renderComposer(selection);
  const photo = attachment({ sizeBytes: 2 * MiB });
  act(() => { result.current.setDraft("Describe this"); result.current.addAttachments([photo]); });
  act(() => result.current.send());
  expect(mockMutate).toHaveBeenCalledTimes(1);
  const [first, callbacks] = mockMutate.mock.calls[0]!;
  act(() => callbacks.onError());
  const id = result.current.optimisticMessages[0]!.id;

  for (const changed of [
    { instanceId: "matrix_pi_default", model: "vision" },
    { instanceId: "matrix_bot_default", model: "text", options: selection.options },
    { instanceId: "matrix_bot_default", model: "vision" },
  ]) {
    rerender({ ...initialProps, selection: changed });
    expect(result.current.optimisticMessages[0]).toMatchObject({ failed: true, retryBlocked: true });
    expect(result.current.attachmentNotice).toContain("To retry a message:");
    act(() => result.current.retrySend(id));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(result.current.optimisticMessages[0]!.attachments).toEqual([photo]);
  }

  rerender(initialProps);
  expect(result.current.optimisticMessages[0]!.retryBlocked).toBe(false);
  act(() => result.current.retrySend(id));
  expect(mockMutate.mock.calls[1]![0]).toMatchObject({
    selection, attachments: [photo], chatRequestId: first.chatRequestId, turnRequestId: first.turnRequestId,
  });
  act(() => mockMutate.mock.calls[1]![1].onError());
  rerender({ ...initialProps, selection: managedSelection });
  act(() => result.current.editUnsent(id));
  expect(result.current.draft).toBe("Describe this");
  expect(result.current.attachments).toEqual([photo]);
  expect(result.current.canSend).toBe(false);
  expect(result.current.optimisticMessages).toEqual([]);
});

it("preflights a project's first send and failed retry without clearing its editable draft", () => {
  const initialProps = {
    projectId: "project_a", selection: { instanceId: "codex_default", model: "vision" },
    catalog: attachmentCatalog(), turnModes: { interactionMode: "default", permissionMode: "supervised" },
    attachmentKinds: ["file"], onChatStarted: jest.fn(),
  } as Parameters<typeof useProjectComposer>[0];
  const { result, rerender } = renderHook((props) => useProjectComposer(props), { initialProps });
  const file = attachment({ kind: "file", mimeType: "application/pdf", sizeBytes: 10 * MiB + 1 });
  act(() => { result.current.setDraft("  Project draft "); result.current.addAttachments([file]); });
  act(() => result.current.send());
  expect(mockMutate).toHaveBeenCalledTimes(1);
  act(() => mockMutate.mock.calls[0]![1].onError());

  rerender({ ...initialProps, selection: managedSelection });
  expect(result.current.canSend).toBe(false);
  expect(result.current.attachmentNotice).toContain("Files must be 10 MiB");
  act(() => result.current.send());
  expect(mockMutate).toHaveBeenCalledTimes(1);
  expect(result.current.draft).toBe("  Project draft ");
  expect(result.current.attachments).toEqual([file]);

  act(() => { result.current.setDraft("Edited project draft"); result.current.removeAttachment(file.id); });
  expect(result.current.canSend).toBe(true);
  expect(result.current.attachmentNotice).toBeNull();
});
