import { MANAGED_WORKERS_AI_MODEL_IDS, managedWorkersAiModel } from "@matrix-os/contracts";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

it("loads the shared Workers catalog through the native contract entrypoint", () => {
  expect(MANAGED_WORKERS_AI_MODEL_IDS).toHaveLength(9);
  expect(MANAGED_WORKERS_AI_MODEL_IDS[0]).toBe("@cf/zai-org/glm-5.3-flash");
  expect(managedWorkersAiModel("@cf/qwen/qwen3.8-27b")).toMatchObject({
    outputTokenField: "max_completion_tokens",
  });
});
