import { describe, expect, it } from "vitest";
import { computeTiledWindowLayout } from "../../shell/src/components/canvas/canvas-auto-arrange.js";

describe("auto arrange", () => {
    it("tiles three windows into a pleasant Tetris layout instead of a single strip", () => {
      const arranged = computeTiledWindowLayout([
        { id: "a", x: 0, y: 0, width: 640, height: 420 },
        { id: "b", x: 2000, y: 0, width: 640, height: 420 },
        { id: "c", x: 4000, y: 0, width: 640, height: 420 },
      ], 1440, 900);

      expect(arranged).toHaveLength(3);
      expect(new Set(arranged.map((rect) => rect.y)).size).toBeGreaterThan(1);
      expect(arranged[0].height).toBeGreaterThan(arranged[1].height);
      expect(arranged[1].x).toBe(arranged[2].x);
    });

    it("tiles three portrait windows with a wide top slot and two lower slots", () => {
      const arranged = computeTiledWindowLayout([
        { id: "a", x: 0, y: 0, width: 640, height: 420 },
        { id: "b", x: 2000, y: 0, width: 640, height: 420 },
        { id: "c", x: 4000, y: 0, width: 640, height: 420 },
      ], 900, 1440);

      expect(arranged).toHaveLength(3);
      expect(arranged[0].width).toBeGreaterThan(arranged[1].width);
      expect(arranged[0].y).toBeLessThan(arranged[1].y);
      expect(arranged[1].y).toBe(arranged[2].y);
      expect(arranged[1].x).toBeLessThan(arranged[2].x);
    });

    it("uses a compact square grid for four windows", () => {
      const arranged = computeTiledWindowLayout([
        { id: "a", x: 0, y: 0, width: 640, height: 420 },
        { id: "b", x: 1000, y: 0, width: 640, height: 420 },
        { id: "c", x: 2000, y: 0, width: 640, height: 420 },
        { id: "d", x: 3000, y: 0, width: 640, height: 420 },
      ], 1440, 900);

      expect(new Set(arranged.map((rect) => rect.x)).size).toBe(2);
      expect(new Set(arranged.map((rect) => rect.y)).size).toBe(2);
      for (const rect of arranged) {
        expect(rect.width).toBeGreaterThanOrEqual(420);
        expect(rect.height).toBeGreaterThanOrEqual(300);
      }
    });

    it("centers incomplete rows in larger tiled grids", () => {
      const arranged = computeTiledWindowLayout([
        { id: "a", x: 0, y: 0, width: 640, height: 420 },
        { id: "b", x: 1000, y: 0, width: 640, height: 420 },
        { id: "c", x: 2000, y: 0, width: 640, height: 420 },
        { id: "d", x: 3000, y: 0, width: 640, height: 420 },
        { id: "e", x: 4000, y: 0, width: 640, height: 420 },
      ], 1440, 900);

      const rowsByY = new Map<number, typeof arranged>();
      for (const rect of arranged) {
        rowsByY.set(rect.y, [...(rowsByY.get(rect.y) ?? []), rect]);
      }
      const [topRow, bottomRow] = [...rowsByY.values()].sort((a, b) => a[0].y - b[0].y);
      const centerOf = (row: typeof arranged) => {
        const left = Math.min(...row.map((rect) => rect.x));
        const right = Math.max(...row.map((rect) => rect.x + rect.width));
        return (left + right) / 2;
      };

      expect(topRow).toHaveLength(3);
      expect(bottomRow).toHaveLength(2);
      expect(centerOf(bottomRow)).toBeCloseTo(centerOf(topRow), 0);
    });
  });
