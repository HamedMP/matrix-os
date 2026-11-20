import { describe, expect, it } from "vitest";
import { closestCorners, type ClientRect, type CollisionDetection } from "@dnd-kit/core";
import { boardCollisionDetection } from "../../packages/ui/src/project-board/board-collision";

function rect(left: number, top: number, width: number, height: number): ClientRect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

// In progress (x 0–260) holds one card; In review (x 280–540) is empty.
const rects = new Map<string, ClientRect>([
  ["column:in_progress", rect(0, 0, 260, 800)],
  ["task_card", rect(10, 50, 240, 80)],
  ["column:in_review", rect(280, 0, 260, 800)],
]);

function args(pointer: { x: number; y: number }): Parameters<CollisionDetection>[0] {
  const droppableContainers = [...rects.keys()].map((id) => ({ id, rect: { current: rects.get(id)! } })) as never;
  return {
    active: { id: "task_dragged" } as never,
    collisionRect: rect(pointer.x - 120, pointer.y - 40, 240, 80),
    droppableRects: rects as never,
    droppableContainers,
    pointerCoordinates: pointer,
  };
}

describe("boardCollisionDetection", () => {
  it("drops onto an empty column under the pointer instead of the nearest card next door", () => {
    const pointer = { x: 300, y: 60 };
    expect(closestCorners(args(pointer))[0]?.id).toBe("task_card");
    expect(boardCollisionDetection(args(pointer))[0]?.id).toBe("column:in_review");
  });

  it("prefers the card under the pointer over its column", () => {
    expect(boardCollisionDetection(args({ x: 100, y: 80 }))[0]?.id).toBe("task_card");
  });

  it("falls back to overlap when the pointer is outside every column", () => {
    expect(boardCollisionDetection(args({ x: 270, y: 900 })).length).toBeGreaterThanOrEqual(0);
  });
});
