// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useCanvasLabels, type CanvasLabel } from "../../shell/src/stores/canvas-labels.js";

function reset() {
  useCanvasLabels.setState({ labels: [] });
}

describe("Canvas Labels Store", () => {
  beforeEach(() => {
    reset();
  });

  describe("createLabel", () => {
    it("creates a label with text, position, and default color", () => {
      const id = useCanvasLabels.getState().createLabel("Work", 100, 200);
      const labels = useCanvasLabels.getState().labels;
      expect(labels).toHaveLength(1);
      expect(labels[0].id).toBe(id);
      expect(labels[0].text).toBe("Work");
      expect(labels[0].x).toBe(100);
      expect(labels[0].y).toBe(200);
      expect(labels[0].color).toBe("#ffffff");
    });

    it("creates a label with custom color", () => {
      useCanvasLabels.getState().createLabel("Life", 300, 400, "#3b82f6");
      expect(useCanvasLabels.getState().labels[0].color).toBe("#3b82f6");
    });

    it("generates unique IDs", () => {
      const id1 = useCanvasLabels.getState().createLabel("A", 0, 0);
      const id2 = useCanvasLabels.getState().createLabel("B", 0, 0);
      expect(id1).not.toBe(id2);
    });
  });

  describe("updateLabel", () => {
    it("updates label text", () => {
      const id = useCanvasLabels.getState().createLabel("Old", 0, 0);
      useCanvasLabels.getState().updateLabel(id, { text: "New" });
      expect(useCanvasLabels.getState().labels[0].text).toBe("New");
    });

    it("updates label position", () => {
      const id = useCanvasLabels.getState().createLabel("Test", 0, 0);
      useCanvasLabels.getState().updateLabel(id, { x: 500, y: 600 });
      const label = useCanvasLabels.getState().labels[0];
      expect(label.x).toBe(500);
      expect(label.y).toBe(600);
    });

    it("updates label color", () => {
      const id = useCanvasLabels.getState().createLabel("Test", 0, 0);
      useCanvasLabels.getState().updateLabel(id, { color: "#ef4444" });
      expect(useCanvasLabels.getState().labels[0].color).toBe("#ef4444");
    });

    it("does not affect other labels", () => {
      useCanvasLabels.getState().createLabel("A", 10, 20);
      const id2 = useCanvasLabels.getState().createLabel("B", 30, 40);
      useCanvasLabels.getState().updateLabel(id2, { text: "B2" });
      expect(useCanvasLabels.getState().labels[0].text).toBe("A");
      expect(useCanvasLabels.getState().labels[1].text).toBe("B2");
    });
  });

  describe("deleteLabel", () => {
    it("removes a label by ID", () => {
      const id = useCanvasLabels.getState().createLabel("Gone", 0, 0);
      useCanvasLabels.getState().deleteLabel(id);
      expect(useCanvasLabels.getState().labels).toHaveLength(0);
    });

    it("only removes the specified label", () => {
      useCanvasLabels.getState().createLabel("Keep", 0, 0);
      const id = useCanvasLabels.getState().createLabel("Remove", 0, 0);
      useCanvasLabels.getState().deleteLabel(id);
      expect(useCanvasLabels.getState().labels).toHaveLength(1);
      expect(useCanvasLabels.getState().labels[0].text).toBe("Keep");
    });
  });

  describe("setLabels", () => {
    it("replaces all labels", () => {
      useCanvasLabels.getState().createLabel("Old", 0, 0);
      const newLabels: CanvasLabel[] = [
        { id: "lbl-1", text: "Work", x: 100, y: 200, color: "#3b82f6" },
        { id: "lbl-2", text: "Life", x: 800, y: 200, color: "#10b981" },
      ];
      useCanvasLabels.getState().setLabels(newLabels);
      expect(useCanvasLabels.getState().labels).toEqual(newLabels);
    });
  });

  describe("moveLabel", () => {
    it("moves a label to a new position", () => {
      const id = useCanvasLabels.getState().createLabel("Test", 100, 200);
      useCanvasLabels.getState().moveLabel(id, 500, 600);
      const label = useCanvasLabels.getState().labels[0];
      expect(label.x).toBe(500);
      expect(label.y).toBe(600);
    });
  });
});
