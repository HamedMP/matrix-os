import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import type { ViewProps } from "../../home/app-templates/connected-starter/src/views/common";
import { JSDOM } from "jsdom";
import { build } from "vite";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
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

// Exercise the real production transform: dev/test worker constructors can hide
// external worker chunks that cannot be started in a srcDoc opaque origin.
let testDom: JSDOM | undefined;
afterEach(async () => {
  if (testDom) {
    const { act, cleanup } = await import("@testing-library/react");
    await act(async () => cleanup());
    await new Promise<void>(resolve => setImmediate(resolve));
    testDom.window.close(); testDom = undefined;
  }
  vi.unstubAllGlobals();
});
describe("installed chess worker loading", () => {
  it("bundles the engine into a local Blob, completes actual bounded search, and terminates it", async () => {
    const result = await build({
      configFile: false,
      root: fileURLToPath(new URL("../../home/app-templates/connected-starter", import.meta.url)),
      logLevel: "silent",
      esbuild: { jsx: "automatic" },
      build: {
        write: false, minify: false,
        lib: { entry: "src/workflows/ChessCoach.tsx", name: "BuiltChessCoach", formats: ["iife"] },
        rollupOptions: { external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime"], output: { globals: { react: "React", "react/jsx-runtime": "ReactJSXRuntime", "react/jsx-dev-runtime": "ReactJSXDevRuntime" } } },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result).output;
    expect(output.filter(chunk => /chess\.worker.*\.js$/.test(chunk.fileName))).toHaveLength(0);
    const entry = output.find(chunk => chunk.type === "chunk");
    if (!entry || entry.type !== "chunk") throw new Error("Missing built component");
    const blobs = new Map<string, string>();
    const workers: OpaqueWorker[] = [];
    const revoke = vi.fn((url: string) => blobs.delete(url));
    class LocalBlob { constructor(readonly parts: string[]) {} }
    class OpaqueWorker {
      addEventListener = vi.fn();
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      terminate = vi.fn();
      context: { onmessage?: (event: { data: unknown }) => void; postMessage: (data: unknown) => void };
      constructor(url: string) {
        // An external asset URL must never be accepted by this opaque-origin
        // harness. Execute the bundled worker itself, not a fabricated score.
        if (!url.startsWith("blob:")) throw new Error("External workers cannot load from this opaque origin");
        const code = blobs.get(url);
        if (!code) throw new Error("Missing local Blob code");
        this.context = { postMessage: data => this.onmessage?.({ data }) };
        runInNewContext(code, { self: this.context, performance, console }, { timeout: 6000 });
        workers.push(this);
      }
      postMessage(data: unknown) { this.context.onmessage?.({ data }); }
    }
    const context = {
      React, ReactJSXRuntime: jsxRuntime, ReactJSXDevRuntime: jsxDevRuntime, Worker: OpaqueWorker, Blob: LocalBlob,
      URL: { createObjectURL(blob: LocalBlob) { const url = `blob:null/${blobs.size}`; blobs.set(url, blob.parts.join("")); return url; }, revokeObjectURL: revoke },
      window: {}, atob, performance, console, setTimeout, clearTimeout,
    };
    Object.assign(context, { self: { Blob: LocalBlob, URL: context.URL } });
    runInNewContext(entry.code, context, { timeout: 1000 });
    const dom = new JSDOM("<!doctype html><html><body></body></html>"); testDom = dom;
    vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.window.document); vi.stubGlobal("navigator", dom.window.navigator);
    const { fireEvent, render, screen, waitFor } = await import("@testing-library/react");
    const Component = (context as typeof context & { BuiltChessCoach: React.ComponentType<ViewProps> }).BuiltChessCoach;
    const onSave = vi.fn(async (_record: ViewProps["records"][number]) => undefined);
    const pgn = "1. e4 1-0";
    render(React.createElement(Component, {
      app: { id: "chess-coach", fields: [] } as unknown as ViewProps["app"],
      records: [{ id: "finished", scope: "personal", fields: { title: "Finished", pgn, status: "Completed" }, sources: [], accounts: [], manualFields: [], updatedAt: "2026-10-07" }],
      onSave, onEdit: vi.fn(), onAdd: vi.fn(), onEvidence: vi.fn(),
    }));
    fireEvent.click(screen.getByRole("button", { name: "Analyze completed game" }));
    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalled(); expect(blobs.size).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Save this local review" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const review = JSON.parse(String(onSave.mock.calls[0][0].fields.analysis));
    expect(review.positions).toHaveLength(1);
    expect(review.positions[0].before.depth).toBeLessThanOrEqual(3);
    expect(review.positions[0].before.nodes).toBeLessThanOrEqual(20000);
    expect(isLegalVariation(review.positions[0].before.fen, review.positions[0].before.variation)).toBe(true);
    expect(review.sourceSignature).toBeTruthy();
  });
});
