import { describe, expect, it } from "vitest";
import { completedGame, searchPosition, analyzeCompletedGame, isLegalVariation } from "../../home/app-templates/connected-starter/src/workflows/chess-engine";

const mate = '[Result "1-0"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';
describe("completed-game local chess analysis", () => {
  it("parses legal completed moves and rejects ongoing, illegal or mismatched games", () => {
    const game = completedGame(mate, "Completed");
    expect(game.moves).toHaveLength(7); expect(game.result).toBe("1-0");
    expect(() => completedGame('1. e4 e5 *', "Completed")).toThrow(/completed/i);
    expect(() => completedGame('1. e4 e5 2. Qh4 1-0', "Completed")).toThrow(/legal/i);
    expect(() => completedGame('[Result "0-1"]\n1. e4 e5 1-0', "Completed")).toThrow(/result/i);
    expect(() => completedGame(mate, "Playing")).toThrow(/completed/i);
    expect(() => completedGame("x".repeat(12001), "Completed")).toThrow();
  });
  it("finds a real mate with legal search and explicitly reports White's score perspective", () => {
    const game = completedGame(mate, "Completed");
    const result = searchPosition(game.positions.at(-1)!.before, { maxDepth: 2, maxNodes: 1000, timeoutMs: 2000 });
    expect(result.bestMove).toBe("Qxf7#"); expect(result.whiteScore).toBeGreaterThan(90000);
    expect(result.depth).toBeGreaterThanOrEqual(1); expect(result.nodes).toBeGreaterThan(0);
    expect(isLegalVariation(result.fen, result.variation)).toBe(true);
  });
  it("honors node and elapsed-time budgets without publishing incomplete-depth scores", () => {
    const fen = completedGame(mate, "Completed").positions[0].before;
    const result = searchPosition(fen, { maxDepth: 3, maxNodes: 1, timeoutMs: 2000 });
    expect(result.nodes).toBeLessThanOrEqual(1); expect(result.depth).toBe(0); expect(result.whiteScore).toBeNull();
    let time = 0;
    const timed = searchPosition(fen, { maxDepth: 3, maxNodes: 1000, timeoutMs: 10, now: () => (time += 100) });
    expect(timed.depth).toBe(0); expect(timed.whiteScore).toBeNull();
  });
  it("does not infer a decisive score for a drawn terminal position", () => {
    const result = searchPosition("4k3/8/8/8/8/8/8/4K3 w - - 0 1", { maxDepth: 2, maxNodes: 1000, timeoutMs: 2000 });
    expect(result.whiteScore).toBe(0); expect(result.bestMove).toBeNull();
  });
  it("analyzes only bounded positions from a selected finished game", () => {
    const result = analyzeCompletedGame(mate, "Completed", { maxDepth: 1, maxNodes: 500, timeoutMs: 2000, positions: 2 });
    expect(result.positions).toHaveLength(2);
    expect(result.positions.every(position => isLegalVariation(position.before.fen, position.before.variation))).toBe(true);
    expect(result.engine).toContain("Local");
  });
});
