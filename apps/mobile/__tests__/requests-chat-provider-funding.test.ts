import { fetchChatProviderCatalog } from "../lib/requests/canonical-chat";
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
    url: "https://example.test/vm/test/api/chat-providers?includeConnectionLabels=true&includeConnectionState=true&includeFundingState=true",
    token: "test-token", errorMessage: "Models unavailable. Try again.",
  }));
});
