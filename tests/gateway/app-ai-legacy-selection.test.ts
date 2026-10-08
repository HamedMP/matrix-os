import { expect, it, vi } from "vitest";
import { createAppAiRoutes } from "../../packages/gateway/src/app-ai/routes.js";

it("fails closed before legacy authorization or inference for an explicit connected route", async () => {
  const authorize = vi.fn(async () => true);
  const generate = vi.fn(async () => ({ text: "wrong account" }));
  const app = createAppAiRoutes({ authorize, generate });
  const response = await app.request("/", { method: "POST", body: JSON.stringify({
    app: "brain", prompt: "notes", route: { harnessId: "pi-personal", accountId: "personal", accessSourceId: "native-profile", modelId: "openai:fixture" },
  }) });
  expect(response.status).toBe(503);
  expect(authorize).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
});
