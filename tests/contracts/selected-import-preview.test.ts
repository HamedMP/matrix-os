import { describe, expect, it } from "vitest";
import { parseSelectedImportPreview } from "../../packages/contracts/src/selected-import-preview.js";

describe("bounded selected export previews", () => {
  it("reads CSV quoted fields, escaped quotes, multiline text and spreadsheet formula text without executing it", () => {
    const result = parseSelectedImportPreview("bank.csv", '\ufeffDate,Description,Amount\r\n2026-10-01,"Coffee, beans",-3\r\n2026-10-02,"A ""quoted""\nnote",=1+2\r\n');
    expect(result).toEqual({ kind: "table", columns: ["Date", "Description", "Amount"], rows: [["2026-10-01", "Coffee, beans", "-3"], ["2026-10-02", 'A "quoted"\nnote', "=1+2"]], truncated: false });
  });
  it("handles TSV exports and caps preview rows while preserving the original file", () => {
    const result = parseSelectedImportPreview("hevy.tsv", `Exercise\tWeight\n${Array.from({ length: 120 }, () => "Squat\t50").join("\n")}`);
    expect(result).toMatchObject({ kind: "table", truncated: true });
    if (result.kind === "table") expect(result.rows).toHaveLength(100);
  });
  it.each(['A,B\n"unfinished', `A\n${"x".repeat(2049)}`, "x\u0000\n1", "A,B\n1,2,3", "A\n".repeat(300000)])("rejects malformed, binary and oversized CSV safely", input => {
    expect(() => parseSelectedImportPreview("bank.csv", input)).toThrow("Import preview unavailable.");
  });
  it("reads one completed PGN game without evaluating moves or calling an engine", () => {
    const result = parseSelectedImportPreview("game.pgn", '[Event "Local game"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0');
    expect(result).toEqual({ kind: "pgn", tags: { Event: "Local game", White: "Alice", Black: "Bob", Result: "1-0" }, moves: "1. e4 e5 2. Nf3 Nc6 1-0", result: "1-0" });
  });
  it.each(["1-0", "0-1", "1/2-1/2"])("accepts each single completed mainline result", result => {
    expect(parseSelectedImportPreview("game.pgn", `1. e4 e5 ${result}`)).toMatchObject({ kind: "pgn", result });
  });
  it.each(['[Result "*"]\n\n1. e4 *', '[Result "1-0"]\n[Result "0-1"]\n1. e4 1-0', '[Result "1-0"]\n\n1. e4 0-1'])("rejects incomplete and ambiguous game exports", input => {
    expect(() => parseSelectedImportPreview("game.pgn", input)).toThrow("Import preview unavailable.");
  });
  it.each([
    "1. e4 1-0\n\n1. d4 0-1",
    "1. e4 0-1 1. d4 0-1",
    "1. e4 1/2-1/2\n1. d4 1-0",
    "1. e4 *\n1. d4 1-0",
  ])("rejects multiple top-level PGN termination markers", input => {
    expect(() => parseSelectedImportPreview("game.pgn", input)).toThrow("Import preview unavailable.");
  });
  it.each([
    "1. e4 {annotation 1-0 and 0-1 and 1/2-1/2 and *} e5 1-0",
    "1. e4 ; annotation 0-1 and 1/2-1/2\n1... e5 1-0",
    "1. e4 (1. d4 0-1 (1. c4 1/2-1/2)) e5 1-0",
    "1. e4 {parentheses ( and ) are inert} (1. d4 {ignore ) 0-1} ; ignore ) 1-0\n1... d5 *) e5 1-0",
  ])("allows result-looking comment and variation text without changing the mainline result", input => {
    expect(parseSelectedImportPreview("game.pgn", input)).toEqual({ kind: "pgn", tags: {}, moves: input, result: "1-0" });
  });
  it.each([
    "1. e4 {unclosed comment 1-0",
    "1. e4 (unclosed variation 1-0",
    "1. e4 ) e5 1-0",
    "1. e4 } e5 1-0",
    "1. e4 ; result only inside a comment 1-0",
    "1. e4 1-0 ; trailing comment falsely ending in 1-0",
  ])("rejects unbalanced PGN context and comment-only results", input => {
    expect(() => parseSelectedImportPreview("game.pgn", input)).toThrow("Import preview unavailable.");
  });
});

it("derives the same inert preview copy for every file surface and reports bounded failures", async () => {
  const { selectedImportPreviewText } = await import("../../packages/contracts/src/selected-import-preview.js");
  expect(selectedImportPreviewText("bank.csv", "Date,Amount\nToday,=1+2")).toBe("Table preview · 1 row\nDate | Amount\nToday | =1+2");
  expect(selectedImportPreviewText("game.pgn", '[White "Alice"]\n[Black "Bob"]\n1. e4 1-0')).toContain("Completed game · 1-0\nWhite: Alice\nBlack: Bob");
  expect(selectedImportPreviewText("bad.csv", 'A\n"unfinished')).toBe("Import preview unavailable. The original file is unchanged.");
  expect(selectedImportPreviewText("plain.txt", "Hello")).toBeNull();
});
