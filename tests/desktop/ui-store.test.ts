import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "@desktop/renderer/src/stores/ui";

beforeEach(() => {
  useUi.setState(useUi.getInitialState(), true);
});

describe("ui store create task dialog state", () => {
  it("records whether project creation should return to Agents", () => {
    useUi.getState().openCreateProject("agents");

    expect(useUi.getState().createProjectOpen).toBe(true);
    expect(useUi.getState().createProjectDestination).toBe("agents");
  });

  it("keeps explicit column preselection only for openCreateTask", () => {
    useUi.getState().openCreateTask("done");
    expect(useUi.getState().createTaskOpen).toBe(true);
    expect(useUi.getState().createTaskStatus).toBe("done");
  });

  it("clears stale column preselection on generic create-task open", () => {
    useUi.getState().openCreateTask("done");
    useUi.getState().setCreateTaskOpen(false);
    useUi.getState().setCreateTaskOpen(true);

    expect(useUi.getState().createTaskOpen).toBe(true);
    expect(useUi.getState().createTaskStatus).toBeNull();
  });
});
