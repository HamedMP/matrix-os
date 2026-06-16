import { beforeEach, describe, expect, it } from "vitest";
import { useEditorTabs } from "@desktop/renderer/src/features/editor/editor-tabs-store";

beforeEach(() => {
  useEditorTabs.setState({ tabsByTask: {}, activePathByTask: {}, dirtyPathsByTask: {} });
});

describe("useEditorTabs", () => {
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
