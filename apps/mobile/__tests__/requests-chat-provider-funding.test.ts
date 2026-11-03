import { admitChatTurn, fetchChatDetail, fetchChatProviderCatalog } from "../lib/requests/canonical-chat";
import { fetchAuthenticatedJson } from "../lib/requests/http";
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

jest.mock("../lib/requests/http", () => ({
  ...jest.requireActual("../lib/requests/http"),
  fetchAuthenticatedJson: jest.fn().mockResolvedValue({ revision: "catalog", drivers: [], instances: [] }),
}));

it("negotiates funding-aware catalog states without changing the authenticated request boundary", async () => {
  await fetchChatProviderCatalog("test-token", "https://example.test/vm/test");
  expect(fetchAuthenticatedJson).toHaveBeenCalledWith(expect.objectContaining({
    url: "https://example.test/vm/test/api/chat-providers?includeConnectionLabels=true&includeConnectionState=true&includeFundingState=true&includeChatFunding=true",
    token: "test-token", errorMessage: "Models unavailable. Try again.",
  }));
});

it("opts Native Mobile detail reads into complete owner command previews", async () => {
  await fetchChatDetail("test-token", "https://example.test/vm/test", "chat_command");
  expect(fetchAuthenticatedJson).toHaveBeenLastCalledWith(expect.objectContaining({
    url: "https://example.test/vm/test/api/chats/chat_command?limit=200&fundingVersion=1&commandPreviewVersion=1&assistantTextVersion=1",
    token: "test-token",
  }));
});

it("negotiates expanded assistant text for turn admission without changing the model request", async () => {
  const input = {
    clientRequestId: "req_mobile_text", baseRevision: 0,
    parts: [{ type: "text" as const, text: "Synthetic request" }],
    selection: { instanceId: "matrix_pi_default", model: "synthetic-model" },
    interactionMode: "default", permissionMode: "supervised",
  };
  await admitChatTurn("test-token", "https://example.test/vm/test", "chat_command", input);
  expect(fetchAuthenticatedJson).toHaveBeenLastCalledWith(expect.objectContaining({
    url: "https://example.test/vm/test/api/chats/chat_command/turns?fundingVersion=1&commandPreviewVersion=1&assistantTextVersion=1",
    token: "test-token", method: "POST", body: JSON.stringify(input),
  }));
});
