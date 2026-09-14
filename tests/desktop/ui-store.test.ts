import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "@desktop/renderer/src/stores/ui";

beforeEach(() => {
  useUi.setState(useUi.getInitialState(), true);
});

describe("ui store project dialog state", () => {
  it("opens the create-project dialog", () => {
    useUi.getState().openCreateProject();

    expect(useUi.getState().createProjectOpen).toBe(true);
  });
});
