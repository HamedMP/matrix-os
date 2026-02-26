// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  useCanvasGroups,
  type CanvasGroup,
} from "../../shell/src/stores/canvas-groups.js";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";

function resetStores() {
  useCanvasGroups.setState({ groups: [] });
  useWindowManager.setState({ windows: [], nextZ: 1, closedPaths: new Set(), apps: [] });
}

describe("Canvas Groups Store", () => {
  beforeEach(() => {
    resetStores();
  });

  describe("CRUD", () => {
    it("creates a group with label, color, and empty windowIds", () => {
      useCanvasGroups.getState().createGroup("Work", "#3b82f6");
      const groups = useCanvasGroups.getState().groups;
      expect(groups).toHaveLength(1);
      expect(groups[0].label).toBe("Work");
      expect(groups[0].color).toBe("#3b82f6");
      expect(groups[0].windowIds).toEqual([]);
      expect(groups[0].collapsed).toBe(false);
    });

    it("deletes a group by id", () => {
      useCanvasGroups.getState().createGroup("Work", "#3b82f6");
      const id = useCanvasGroups.getState().groups[0].id;
      useCanvasGroups.getState().deleteGroup(id);
      expect(useCanvasGroups.getState().groups).toHaveLength(0);
    });

    it("renames a group", () => {
      useCanvasGroups.getState().createGroup("Work", "#3b82f6");
      const id = useCanvasGroups.getState().groups[0].id;
      useCanvasGroups.getState().renameGroup(id, "Office");
      expect(useCanvasGroups.getState().groups[0].label).toBe("Office");
    });

    it("sets group color", () => {
      useCanvasGroups.getState().createGroup("Work", "#3b82f6");
      const id = useCanvasGroups.getState().groups[0].id;
      useCanvasGroups.getState().setGroupColor(id, "#ef4444");
      expect(useCanvasGroups.getState().groups[0].color).toBe("#ef4444");
    });
  });

  describe("membership", () => {
    it("adds a window to a group", () => {
      useCanvasGroups.getState().createGroup("Work", "#3b82f6");
      const groupId = useCanvasGroups.getState().groups[0].id;
      useCanvasGroups.getState().addToGroup(groupId, "win-1");
      expect(useCanvasGroups.getState().groups[0].windowIds).toEqual(["win-1"]);
    });

    it("removes a window from a group", () => {
      useCanvasGroups.getState().createGroup("Work", "#3b82f6");
      const groupId = useCanvasGroups.getState().groups[0].id;
      useCanvasGroups.getState().addToGroup(groupId, "win-1");
      useCanvasGroups.getState().addToGroup(groupId, "win-2");
      useCanvasGroups.getState().removeFromGroup(groupId, "win-1");
      expect(useCanvasGroups.getState().groups[0].windowIds).toEqual(["win-2"]);
    });

    it("enforces single-group membership", () => {
      useCanvasGroups.getState().createGroup("Work", "#3b82f6");
      useCanvasGroups.getState().createGroup("Play", "#10b981");
      const [g1, g2] = useCanvasGroups.getState().groups;
      useCanvasGroups.getState().addToGroup(g1.id, "win-1");
      useCanvasGroups.getState().addToGroup(g2.id, "win-1");
      const updated = useCanvasGroups.getState().groups;
      expect(updated.find((g) => g.id === g1.id)?.windowIds).toEqual([]);
      expect(updated.find((g) => g.id === g2.id)?.windowIds).toEqual(["win-1"]);
    });

    it("does not add duplicate window to same group", () => {
      useCanvasGroups.getState().createGroup("Work", "#3b82f6");
      const groupId = useCanvasGroups.getState().groups[0].id;
      useCanvasGroups.getState().addToGroup(groupId, "win-1");
      useCanvasGroups.getState().addToGroup(groupId, "win-1");
      expect(useCanvasGroups.getState().groups[0].windowIds).toEqual(["win-1"]);
    });
  });

  describe("collapse", () => {
    it("toggles collapsed state", () => {
      useCanvasGroups.getState().createGroup("Work", "#3b82f6");
      const id = useCanvasGroups.getState().groups[0].id;
      expect(useCanvasGroups.getState().groups[0].collapsed).toBe(false);
      useCanvasGroups.getState().toggleCollapsed(id);
      expect(useCanvasGroups.getState().groups[0].collapsed).toBe(true);
      useCanvasGroups.getState().toggleCollapsed(id);
      expect(useCanvasGroups.getState().groups[0].collapsed).toBe(false);
    });
  });

  describe("bounds", () => {
    it("calculates group bounds from member windows", () => {
      useWindowManager.getState().openWindow("App1", "apps/app1.html", 20);
      useWindowManager.getState().openWindow("App2", "apps/app2.html", 20);
      const [w1, w2] = useWindowManager.getState().windows;

      useWindowManager.getState().moveWindow(w1.id, 100, 100);
      useWindowManager.getState().moveWindow(w2.id, 500, 400);

      useCanvasGroups.getState().createGroup("Work", "#3b82f6");
      const groupId = useCanvasGroups.getState().groups[0].id;
      useCanvasGroups.getState().addToGroup(groupId, w1.id);
      useCanvasGroups.getState().addToGroup(groupId, w2.id);

      const bounds = useCanvasGroups.getState().getGroupBounds(groupId);
      expect(bounds).toBeDefined();
      // Min x=100, min y=100, max x=500+640, max y=400+480, + 20px padding
      expect(bounds!.x).toBe(80); // 100 - 20 padding
      expect(bounds!.y).toBe(80); // 100 - 20 padding
      expect(bounds!.width).toBe(500 + 640 - 100 + 40); // content + 2*20 padding
      expect(bounds!.height).toBe(400 + 480 - 100 + 40); // content + 2*20 padding
    });

    it("returns null for empty group", () => {
      useCanvasGroups.getState().createGroup("Empty", "#3b82f6");
      const id = useCanvasGroups.getState().groups[0].id;
      expect(useCanvasGroups.getState().getGroupBounds(id)).toBeNull();
    });

    it("returns null for unknown group", () => {
      expect(useCanvasGroups.getState().getGroupBounds("nonexistent")).toBeNull();
    });
  });
});
