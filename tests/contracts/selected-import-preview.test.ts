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
  it.each(['[Result "*"]\n\n1. e4 *', '[Result "1-0"]\n[Result "0-1"]\n1. e4 1-0', '[Result "1-0"]\n\n1. e4 0-1'])("rejects incomplete and ambiguous game exports", input => {
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
