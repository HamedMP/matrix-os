import { describe, expect, it } from "vitest";
import {
  addElement,
  boundsOf,
  canRedo,
  canUndo,
  commit,
  createHistory,
  deleteElement,
  deserializeScene,
  elementsInRect,
  emptyScene,
  hitTest,
  hitTestScene,
  makeId,
  moveElement,
  redo,
  serializeScene,
  undo,
  updateElement,
  type BoxElement,
  type LineElement,
  type PenElement,
} from "../../home/apps/whiteboard/src/whiteboard-model";

function rect(id: string, x: number, y: number, w: number, h: number): BoxElement {
  return { id, kind: "rect", x, y, width: w, height: h, stroke: "#000", fill: "transparent", strokeWidth: 2 };
}

describe("whiteboard model — CRUD", () => {
  it("adds an element immutably", () => {
    const s0 = emptyScene();
    const s1 = addElement(s0, rect("a", 0, 0, 10, 10));
    expect(s0.elements).toHaveLength(0);
    expect(s1.elements).toHaveLength(1);
    expect(s1.elements[0].id).toBe("a");
  });

  it("updates an element by id with a partial patch", () => {
    const s1 = addElement(emptyScene(), rect("a", 0, 0, 10, 10));
    const s2 = updateElement(s1, "a", { stroke: "#f00" } as Partial<BoxElement>);
    expect((s2.elements[0] as BoxElement).stroke).toBe("#f00");
    // original untouched
    expect((s1.elements[0] as BoxElement).stroke).toBe("#000");
  });

  it("moves an element by delta", () => {
    const s1 = addElement(emptyScene(), rect("a", 5, 5, 10, 10));
    const s2 = moveElement(s1, "a", 3, -2);
    const b = boundsOf(s2.elements[0]);
    expect(b.x).toBe(8);
    expect(b.y).toBe(3);
  });

  it("moves a line element by translating both endpoints", () => {
    const line: LineElement = {
      id: "l", kind: "line", x1: 0, y1: 0, x2: 10, y2: 10,
      stroke: "#000", fill: "transparent", strokeWidth: 2,
    };
    const s = moveElement(addElement(emptyScene(), line), "l", 5, 5);
    const moved = s.elements[0] as LineElement;
    expect([moved.x1, moved.y1, moved.x2, moved.y2]).toEqual([5, 5, 15, 15]);
  });

  it("deletes an element by id", () => {
    const s1 = addElement(addElement(emptyScene(), rect("a", 0, 0, 1, 1)), rect("b", 5, 5, 1, 1));
    const s2 = deleteElement(s1, "a");
    expect(s2.elements.map((e) => e.id)).toEqual(["b"]);
  });
});

describe("whiteboard model — hit testing", () => {
  it("hits inside a rectangle", () => {
    const r = rect("a", 0, 0, 20, 20);
    expect(hitTest(r, 10, 10)).toBe(true);
    expect(hitTest(r, 100, 100)).toBe(false);
  });

  it("hits near a line stroke within tolerance", () => {
    const line: LineElement = {
      id: "l", kind: "line", x1: 0, y1: 0, x2: 100, y2: 0,
      stroke: "#000", fill: "transparent", strokeWidth: 2,
    };
    expect(hitTest(line, 50, 2)).toBe(true);
    expect(hitTest(line, 50, 40)).toBe(false);
  });

  it("hits a pen stroke near its path", () => {
    const pen: PenElement = {
      id: "p", kind: "pen",
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
      stroke: "#000", fill: "transparent", strokeWidth: 2,
    };
    expect(hitTest(pen, 15, 1)).toBe(true);
    expect(hitTest(pen, 15, 50)).toBe(false);
  });

  it("returns the topmost element under a point", () => {
    const s = addElement(addElement(emptyScene(), rect("under", 0, 0, 50, 50)), rect("over", 0, 0, 50, 50));
    expect(hitTestScene(s, 25, 25)?.id).toBe("over");
    expect(hitTestScene(s, 500, 500)).toBeNull();
  });

  it("selects elements intersecting a marquee rectangle", () => {
    const s = addElement(addElement(emptyScene(), rect("a", 0, 0, 10, 10)), rect("b", 100, 100, 10, 10));
    const inside = elementsInRect(s, -5, -5, 30, 30).map((e) => e.id);
    expect(inside).toEqual(["a"]);
  });
});

describe("whiteboard model — history (undo/redo)", () => {
  it("undoes and redoes committed scenes", () => {
    let h = createHistory(emptyScene());
    expect(canUndo(h)).toBe(false);

    const s1 = addElement(h.present, rect("a", 0, 0, 1, 1));
    h = commit(h, s1);
    const s2 = addElement(h.present, rect("b", 1, 1, 1, 1));
    h = commit(h, s2);

    expect(h.present.elements).toHaveLength(2);
    expect(canUndo(h)).toBe(true);

    h = undo(h);
    expect(h.present.elements.map((e) => e.id)).toEqual(["a"]);
    expect(canRedo(h)).toBe(true);

    h = undo(h);
    expect(h.present.elements).toHaveLength(0);
    expect(canUndo(h)).toBe(false);

    h = redo(h);
    expect(h.present.elements.map((e) => e.id)).toEqual(["a"]);
    h = redo(h);
    expect(h.present.elements.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("clears the redo stack after a new commit", () => {
    let h = createHistory(emptyScene());
    h = commit(h, addElement(h.present, rect("a", 0, 0, 1, 1)));
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = commit(h, addElement(h.present, rect("c", 2, 2, 1, 1)));
    expect(canRedo(h)).toBe(false);
    expect(h.present.elements.map((e) => e.id)).toEqual(["c"]);
  });

  it("caps the undo stack at the configured limit", () => {
    let h = createHistory(emptyScene(), 3);
    for (let i = 0; i < 10; i += 1) {
      h = commit(h, addElement(h.present, rect(`r${i}`, i, i, 1, 1)));
    }
    expect(h.past.length).toBeLessThanOrEqual(3);
  });
});

describe("whiteboard model — serialization", () => {
  it("round-trips a scene through serialize/deserialize", () => {
    let s = emptyScene();
    s = addElement(s, rect("a", 1, 2, 3, 4));
    s = addElement(s, {
      id: "l", kind: "arrow", x1: 0, y1: 0, x2: 5, y2: 5,
      stroke: "#abc", fill: "transparent", strokeWidth: 4,
    } as LineElement);
    s = addElement(s, {
      id: "p", kind: "pen", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
      stroke: "#def", fill: "transparent", strokeWidth: 3,
    } as PenElement);
    s = addElement(s, {
      id: "n", kind: "sticky", x: 10, y: 10, width: 80, height: 80,
      text: "hello", stroke: "#111", fill: "#ff0", strokeWidth: 1,
    } as BoxElement);

    const serialized = serializeScene(s);
    expect(serialized.version).toBe(1);

    const restored = deserializeScene(JSON.parse(JSON.stringify(serialized)));
    expect(restored.elements).toHaveLength(4);
    expect(restored.elements.map((e) => e.id)).toEqual(["a", "l", "p", "n"]);
    expect((restored.elements[3] as BoxElement).text).toBe("hello");
    expect((restored.elements[2] as PenElement).points).toHaveLength(2);
  });

  it("deserializes from a JSON string and drops malformed elements", () => {
    const json = JSON.stringify({
      version: 1,
      elements: [
        { id: "ok", kind: "rect", x: 0, y: 0, width: 5, height: 5, stroke: "#000", fill: "transparent", strokeWidth: 2 },
        { id: "bad", kind: "rect", x: "nope", y: 0, width: 5, height: 5 },
        { kind: "mystery" },
      ],
    });
    const scene = deserializeScene(json);
    expect(scene.elements).toHaveLength(1);
    expect(scene.elements[0].id).toBe("ok");
  });

  it("returns an empty scene for invalid input", () => {
    expect(deserializeScene("not json {{{").elements).toHaveLength(0);
    expect(deserializeScene(null).elements).toHaveLength(0);
    expect(deserializeScene(42).elements).toHaveLength(0);
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => makeId()));
    expect(ids.size).toBe(200);
  });
});
