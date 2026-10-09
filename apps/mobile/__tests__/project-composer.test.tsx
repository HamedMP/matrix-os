import { act, renderHook } from "@testing-library/react-native";

import { useProjectComposer } from "../components/projects/use-project-composer";

interface SentMessage {
  chatId: string | null;
  baseRevision: number;
  text: string;
  projectId: string | null;
  chatRequestId: string;
  turnRequestId: string;
  onChatCreated?: (chatId: string) => void;
}

const mockMutate = jest.fn();
let mockPending = false;

jest.mock("@/lib/queries/use-send-chat-message", () => ({
  useSendChatMessage: () => ({ mutate: mockMutate, isPending: mockPending }),
}));

const selection = { instanceId: "matrix-ai", model: "sonnet-5" };
const turnModes = { interactionMode: "default", permissionMode: "supervised" };

type Options = Parameters<typeof useProjectComposer>[0];

function renderComposer(overrides: Partial<Options> = {}) {
  const onChatStarted = jest.fn();
  const initialProps: Options = { projectId: "proj_portfolio", selection, turnModes, onChatStarted, ...overrides };
  const hook = renderHook((props: Options) => useProjectComposer(props), { initialProps });
  return { ...hook, onChatStarted, initialProps };
}

const sent = (call = 0) => mockMutate.mock.calls[call][0] as SentMessage;
const callbacks = (call = 0) => mockMutate.mock.calls[call][1] as { onError: () => void };

describe("useProjectComposer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPending = false;
  });

  it("starts with an empty box that cannot be sent", () => {
    const { result } = renderComposer();

    expect(result.current).toMatchObject({ draft: "", canSend: false, isSending: false });
    act(() => result.current.send());
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("sends the text as the first message of a new chat in the project", () => {
    const { result } = renderComposer();

    act(() => result.current.setDraft("  Draft the case study "));
    expect(result.current.canSend).toBe(true);
    act(() => result.current.send());

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({
      chatId: null,
      baseRevision: 0,
      text: "Draft the case study",
      selection,
      interactionMode: "default",
      permissionMode: "supervised",
      projectId: "proj_portfolio",
    });
    expect(sent().chatRequestId).toMatch(/^req_[A-Za-z0-9]+$/);
    expect(sent().turnRequestId).toMatch(/^req_[A-Za-z0-9]+$/);
    expect(sent().turnRequestId).not.toBe(sent().chatRequestId);
  });

  it("keeps the text in the box until the server has the message, then reports the chat and the model it started with", () => {
    const { result, onChatStarted } = renderComposer();
    act(() => result.current.setDraft("Draft the case study"));
    act(() => result.current.send());

    expect(result.current.draft).toBe("Draft the case study");
    expect(onChatStarted).not.toHaveBeenCalled();

    act(() => sent().onChatCreated?.("chat_new"));

    expect(onChatStarted).toHaveBeenCalledWith("chat_new", selection);
    expect(result.current.draft).toBe("");
  });

  it("says a send is in flight, and sends nothing more meanwhile", () => {
    mockPending = true;
    const { result } = renderComposer();
    act(() => result.current.setDraft("Draft the case study"));

    expect(result.current).toMatchObject({ isSending: true, canSend: false });
    act(() => result.current.send());

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it.each([
    ["it is held back", { disabled: true }],
    ["there is no model to send to", { selection: null }],
    ["the model's modes are not known", { turnModes: null }],
    ["there is no project", { projectId: null }],
  ])("does not send while %s", (_case, overrides) => {
    const { result } = renderComposer(overrides);
    act(() => result.current.setDraft("Draft the case study"));

    expect(result.current.canSend).toBe(false);
    act(() => result.current.send());

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("keeps the text after a failure and retries it under the same request ids", () => {
    const { result, onChatStarted } = renderComposer();
    act(() => result.current.setDraft("Draft the case study"));
    act(() => result.current.send());
    act(() => callbacks().onError());

    expect(result.current.draft).toBe("Draft the case study");
    expect(onChatStarted).not.toHaveBeenCalled();

    act(() => result.current.send());

    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(sent(1).chatRequestId).toBe(sent(0).chatRequestId);
    expect(sent(1).turnRequestId).toBe(sent(0).turnRequestId);
  });

  it("gives different text its own request ids, and the first text its old ones when it comes back", () => {
    const { result } = renderComposer();
    act(() => result.current.setDraft("First wording"));
    act(() => result.current.send());
    act(() => callbacks(0).onError());

    act(() => result.current.setDraft("Second wording"));
    act(() => result.current.send());
    act(() => callbacks(1).onError());
    expect(sent(1).chatRequestId).not.toBe(sent(0).chatRequestId);
    expect(sent(1).turnRequestId).not.toBe(sent(0).turnRequestId);

    act(() => result.current.setDraft("First wording"));
    act(() => result.current.send());
    expect(sent(2).chatRequestId).toBe(sent(0).chatRequestId);
    expect(sent(2).turnRequestId).toBe(sent(0).turnRequestId);
  });

  it("treats the same text as a new message once an earlier send has gone through", () => {
    const { result } = renderComposer();
    act(() => result.current.setDraft("Draft the case study"));
    act(() => result.current.send());
    act(() => callbacks(0).onError());
    act(() => result.current.send());
    act(() => sent(1).onChatCreated?.("chat_new"));

    act(() => result.current.setDraft("Draft the case study"));
    act(() => result.current.send());

    expect(sent(2).chatRequestId).not.toBe(sent(0).chatRequestId);
    expect(sent(2).turnRequestId).not.toBe(sent(0).turnRequestId);
  });

  it("does not carry a failed send's request ids over to another project", () => {
    const { result, rerender, initialProps } = renderComposer();
    act(() => result.current.setDraft("Draft the case study"));
    act(() => result.current.send());
    act(() => callbacks(0).onError());

    rerender({ ...initialProps, projectId: "proj_matrix" });
    act(() => result.current.send());

    expect(sent(1).projectId).toBe("proj_matrix");
    expect(sent(1).chatRequestId).not.toBe(sent(0).chatRequestId);
  });
});
