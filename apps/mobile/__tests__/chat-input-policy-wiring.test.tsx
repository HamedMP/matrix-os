import type { ReactElement, ReactNode } from "react";
import { act, renderHook } from "@testing-library/react-native";

import { useAgentThread } from "../components/agents/use-agent-thread";
import { ActiveChatProvider, useActiveChat } from "../components/chat/active-chat";
import type { ComposerAttachment } from "../lib/chat-attachments";
import { attachment, attachmentCatalog, managedSelection, MiB } from "./attachment-policy-fixtures";

const mockMutate = jest.fn();
let mockCatalog = attachmentCatalog();
let mockSelection = managedSelection;
const mockComputer = { handle: "computer", runtimeSlot: "primary", gatewayPath: "/vm/computer" };

jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ isSignedIn: true, userId: "user_a" }) }));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({ activeChatId: "chat_a", selectionOverride: mockSelection, selectedProjectId: null }),
}));
jest.mock("@/lib/queries/use-canonical-chat-detail", () => ({
  useCanonicalChatDetail: () => ({
    detail: {
      record: { chat: { id: "chat_a", revision: 1, currentSelection: mockSelection } }, runs: [], messages: [], turns: [],
    },
    computer: mockComputer,
  }),
}));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({ chats: [] }) }));
jest.mock("@/lib/queries/use-chat-provider-catalog", () => ({
  useChatProviderCatalog: () => ({ catalog: mockCatalog, isPending: false, isFetching: false }),
}));
jest.mock("@/lib/queries/use-send-chat-message", () => ({
  useSendChatMessage: () => ({ mutate: mockMutate, isPending: false }),
}));
jest.mock("@/lib/queries/use-bot-chat", () => ({ useBotChat: () => ({ snapshot: null }) }));
jest.mock("@/components/agents/use-agent-chat-sync", () => ({ useAgentChatSync: jest.fn() }));
jest.mock("@/components/chat/use-chat-thread", () => ({
  useChatThread: () => ({ messages: [], running: false }),
}));
jest.mock("@/lib/use-session-token-warmup", () => ({ useSessionTokenWarmup: () => jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  mockCatalog = attachmentCatalog();
  mockSelection = managedSelection;
});

it("ordinary chat passes its live catalog and selection before any optimistic send", () => {
  const wrapper = ({ children }: { children: ReactNode }) => <ActiveChatProvider>{children}</ActiveChatProvider>;
  const { result, rerender } = renderHook(() => useActiveChat(), { wrapper });
  const photo = attachment({ mimeType: "image/gif", name: "animation.gif" });
  act(() => { result.current.composer.setDraft("  Ordinary draft "); result.current.composer.addAttachments([photo]); });
  expect(result.current.composer.attachmentNotice).toBe("Use PNG, JPEG or WebP images for this model.");
  expect(result.current.composer.canSend).toBe(false);
  act(() => result.current.composer.send());
  expect(mockMutate).not.toHaveBeenCalled();
  expect(result.current.composer.draft).toBe("  Ordinary draft ");
  expect(result.current.composer.attachments).toEqual([photo]);

  mockSelection = { instanceId: "codex_default", model: "vision" };
  rerender({});
  expect(result.current.composer.attachmentNotice).toBeNull();
  expect(result.current.composer.canSend).toBe(true);
  act(() => result.current.composer.send());
  expect(mockMutate).toHaveBeenCalledWith(expect.objectContaining({ selection: mockSelection, attachments: [photo] }), expect.anything());
});

it("agent chat exposes the same actionable notice and preserves editable attachments under changed model policy", () => {
  const { result, rerender } = renderHook(() => useAgentThread({ agent: null, chatId: "chat_a" }));
  const photo = attachment({ sizeBytes: MiB + 1 });
  const addControl = result.current.composer.addControl as ReactElement<{ onAdd: (parts: ComposerAttachment[]) => void }>;
  act(() => { result.current.composer.onChangeDraft("Agent draft"); addControl.props.onAdd([photo]); });
  expect(result.current.composer.attachmentNotice).toBe("Images for this Matrix AI source must total 1 MiB or less.");
  expect(result.current.composer.canSend).toBe(false);
  act(() => result.current.composer.onSend());
  expect(mockMutate).not.toHaveBeenCalled();
  expect(result.current.composer.draft).toBe("Agent draft");
  expect(result.current.composer.attachments).toEqual([photo]);

  mockSelection = { instanceId: "matrix_pi_own", model: "vision" };
  rerender({});
  expect(result.current.composer.attachmentNotice).toBeNull();
  expect(result.current.composer.canSend).toBe(true);
  act(() => result.current.composer.onSend());
  expect(mockMutate).toHaveBeenCalledWith(expect.objectContaining({ selection: mockSelection, attachments: [photo] }), expect.anything());
});
