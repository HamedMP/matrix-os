import { describe, expect, it, vi } from "vitest";
import { scanCsv } from "../../../../home/apps/sheets/src/session/engine";
import { MAX_IMPORT_AREA, csvExtent, parsePastedTable } from "../../../../home/apps/sheets/src/ui/import-csv";

const reads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../../../home/apps/sheets/src/session/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../home/apps/sheets/src/session/engine")>();
  return {
    ...actual,
    scanCsv: (...args: Parameters<typeof actual.scanCsv>) => {
      reads.count++;
      return actual.scanCsv(...args);
    },
  };
});

/** The fields the CSV reader builds and the area the trimmed rows span, from the reader's own output. */
function measured(text: string, delimiter: string): { fields: number; area: number } {
  const records = scanCsv(text, { delimiter });
  let fields = 0;
  let used = 0;
  let width = 0;
  records.forEach((record, index) => {
    fields += record.length;
    let last = record.length;
    while (last > 0 && record[last - 1]!.text === "") last--;
    if (last > 0) used = index + 1;
    width = Math.max(width, last);
  });
  return { fields, area: used * width };
}

describe("importing pasted rows: size", () => {
  // Outcome: the size of pasted text is counted exactly as the CSV reader would read it.
  // Fault: a count that differs from the reader lets text through that builds more fields than allowed.
  it("counts fields and area as the CSV reader reads them", () => {
    const samples: Array<[string, string]> = [
      ["a,b\n1,2\n", ","],
      ["a,b\r\n\r\n\n,c,\n\n", ","],
      ['"x,y",z\n"q""uote"tail,\n"",,""\n', ","],
      ['"unclosed,\nrest', ","],
      ["a;b;\n;\n;;;x", ";"],
      ["a\tb\t\n\t\t\n", "\t"],
      ["trailing,", ","],
      ["\n\n\n", ","],
      ["", ","],
    ];
    for (const [text, delimiter] of samples) expect(csvExtent(text, delimiter, Number.POSITIVE_INFINITY), JSON.stringify(text)).toEqual(measured(text, delimiter));
  });

  // Outcome: pasted text whose rows times widest row, or whose fields, pass the import limit is
  // refused before the CSV reader builds any field. Fault: millions of empty fields were built first
  // and the area was checked only afterwards.
  it("refuses an oversized paste before the CSV reader builds its fields", () => {
    expect(csvExtent(",".repeat(MAX_IMPORT_AREA + 1), ",", MAX_IMPORT_AREA)).toBeNull();
    expect(csvExtent(`${"x\n".repeat(2_000)}${",".repeat(1_000)}x`, ",", MAX_IMPORT_AREA)).toBeNull();
    expect(csvExtent("a,b\n", ",", MAX_IMPORT_AREA)).toEqual({ fields: 2, area: 2 });

    reads.count = 0;
    const emptyFields = `${",".repeat(999)}\n`.repeat(4_000);
    expect(parsePastedTable(emptyFields)).toEqual({ ok: false, message: "The pasted text has more cells than Sheets imports at once." });
    const tall = `${"x\n".repeat(2_000)}${",".repeat(1_000)}x`;
    expect(parsePastedTable(tall)).toEqual({ ok: false, message: "The pasted text has more cells than Sheets imports at once." });
    expect(reads.count).toBe(0);
    expect(parsePastedTable("a,b\n1,2\n")).toEqual({ ok: true, rows: [["a", "b"], ["1", "2"]] });
    expect(reads.count).toBe(1);
  });
});
