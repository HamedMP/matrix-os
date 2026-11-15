import { MANAGED_WORKERS_AI_MODEL_IDS, managedWorkersAiModel } from "@matrix-os/contracts";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

it("loads the shared Workers catalog through the native contract entrypoint", () => {
  expect(MANAGED_WORKERS_AI_MODEL_IDS).toHaveLength(10);
  expect(MANAGED_WORKERS_AI_MODEL_IDS[0]).toBe("@cf/zai-org/glm-5.3-flash");
  expect(MANAGED_WORKERS_AI_MODEL_IDS).toEqual(expect.arrayContaining([
    "@cf/zai-org/glm-5.3",
    "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  ]));
  expect(managedWorkersAiModel("@cf/deepseek-ai/deepseek-v4.1-flash-1017")).toMatchObject({
    outputTokenField: "max_completion_tokens",
    vision: true,
  });
  expect(managedWorkersAiModel("@cf/qwen/qwen3.8-27b")).toMatchObject({
    outputTokenField: "max_completion_tokens",
  });
});
