import { beforeEach, expect, it } from "vitest";
import { useCreateAppRequest } from "@desktop/renderer/src/stores/create-app-request";

beforeEach(() => useCreateAppRequest.setState(useCreateAppRequest.getInitialState(), true));

it("prepares a Matrix builder-agent draft for the Create App launcher", () => {
  useCreateAppRequest.getState().requestDraft();

  expect(useCreateAppRequest.getState().request?.prompt).toContain("Matrix builder agent");
  expect(useCreateAppRequest.getState().request?.prompt).toContain("app-generation.md");
});
