import { expect, it } from "vitest";
import { prepareAppAiRequest } from "../../shell/src/components/app-ai-request.js";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy.js";

it("injects trusted app identity and rejects payload impersonation", () => {
  expect(JSON.parse(prepareAppAiRequest("brain", { method: "POST", body: '{"prompt":"hello"}' }).body as string))
    .toEqual({ app: "brain", prompt: "hello" });
  expect(() => prepareAppAiRequest("brain", { method: "POST", body: '{"app":"other","prompt":"hello"}' })).toThrow();
});
it.each(["/api/bridge/ai?x=1", "/api/bridge/ai/", "/api/bridge/x/../ai", "/api/bridge/%61i", "https://evil.test/api/bridge/ai"])("rejects endpoint aliases: %s", (url) => {
  expect(isAllowedBridgeFetchUrl("brain", url)).toBe(false);
});
it("allows the exact AI endpoint", () => expect(isAllowedBridgeFetchUrl("brain", "/api/bridge/ai")).toBe(true));
