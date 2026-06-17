import { beforeEach, describe, expect, it } from "vitest";
import { useEditorTabs } from "@desktop/renderer/src/features/editor/editor-tabs-store";

beforeEach(() => {
  useEditorTabs.setState({ tabsByTask: {}, activePathByTask: {}, dirtyPathsByTask: {} });
});

describe("useEditorTabs", () => {
  it("drops dirty flags for paths evicted by the tab cap", () => {
    const store = useEditorTabs.getState();
    for (let i = 0; i < 16; i += 1) {
      store.openTab("task_a", `src/${i}.ts`);
    }
    store.setDirty("task_a", "src/0.ts", true);
    store.setDirty("task_a", "src/15.ts", true);

    store.openTab("task_a", "src/16.ts");

    const state = useEditorTabs.getState();
    expect(state.tabsByTask.task_a).not.toContain("src/0.ts");
    expect(state.dirtyPathsByTask.task_a).toEqual(["src/15.ts"]);
  });

  it("clears dirty paths owned by a closed task", () => {
    const store = useEditorTabs.getState();
    store.openTab("task_a", "src/a.ts");
    store.openTab("task_a", "src/shared.ts");
    store.openTab("task_b", "src/b.ts");
    store.openTab("task_b", "src/shared.ts");
    store.setDirty("task_a", "src/a.ts", true);
    store.setDirty("task_a", "src/shared.ts", true);
    store.setDirty("task_b", "src/b.ts", true);
    store.setDirty("task_b", "src/shared.ts", true);

    store.closeTask("task_a");

    const state = useEditorTabs.getState();
    expect(state.tabsByTask).toEqual({ task_b: ["src/b.ts", "src/shared.ts"] });
    expect(state.activePathByTask).toEqual({ task_b: "src/shared.ts" });
    expect(state.dirtyPathsByTask).toEqual({ task_b: ["src/b.ts", "src/shared.ts"] });
  });
});
