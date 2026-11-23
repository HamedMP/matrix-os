import { describe, expect, it } from "vitest";

import { DEFAULT_DOCX_LIMITS, openDocx, toHtml } from "../../../../packages/office/src/docx/index.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { buildPackage, cell, p, r, row, tbl } from "./build.js";

const OPTIONS = { track: false, author: "Owner", date: "2026-01-01T00:00:00Z" };

async function bytesOf(body: string, headers?: Record<string, string>): Promise<Uint8Array> {
  return buildPackage({ body, headers }).pkg.save();
}

/** The limit a refused document names, or the reason it was not refused. */
async function refusedBy(bytes: Uint8Array, limits?: Parameters<typeof openDocx>[1]): Promise<unknown> {
  try {
    await openDocx(bytes, limits);
  } catch (error) {
    if (isOfficeError(error, "limit_exceeded")) return error.details.limit;
    throw error;
  }
  return "opened";
}

describe("a small file cannot make a large document", () => {
  it("publishes frozen defaults that fit a 10 MiB file", () => {
    expect(DEFAULT_DOCX_LIMITS).toEqual({
      maxNodes: 500_000,
      maxXmlChars: 32 * 1024 * 1024,
      maxBlocks: 50_000,
      maxTableRows: 20_000,
      maxTableCells: 50_000,
    });
    expect(Object.isFrozen(DEFAULT_DOCX_LIMITS)).toBe(true);
  });

  it("refuses a table of 150,000 rows that zips to a few kilobytes", async () => {
    const bytes = await bytesOf(`${tbl("<w:tr><w:tc><w:p/></w:tc></w:tr>".repeat(150_000))}<w:p/>`);
    expect(bytes.length).toBeLessThan(64 * 1024);
    expect(await refusedBy(bytes)).toBe("maxTableRows");
  });

  it("refuses a row of 60,000 cells", async () => {
    expect(await refusedBy(await bytesOf(`${tbl(`<w:tr>${"<w:tc/>".repeat(60_000)}</w:tr>`)}<w:p/>`))).toBe("maxTableCells");
  });

  it("refuses 60,000 paragraphs, in the body or in the cells of a table", async () => {
    expect(await refusedBy(await bytesOf("<w:p/>".repeat(60_000)))).toBe("maxBlocks");
    const cells = `<w:tc>${"<w:p/>".repeat(1000)}</w:tc>`.repeat(60);
    expect(await refusedBy(await bytesOf(`${tbl(`<w:tr>${cells}</w:tr>`)}<w:p/>`))).toBe("maxBlocks");
  });

  it("refuses more XML nodes than the budget, before it builds the document", async () => {
    const bytes = await bytesOf(p("<w:r/>".repeat(600_000)));
    expect(bytes.length).toBeLessThan(64 * 1024);
    expect(await refusedBy(bytes)).toBe("maxNodes");
  });

  it("opens a document of ordinary size", async () => {
    const document = await openDocx(await bytesOf(p(r("clause")).repeat(5000) + tbl(row(cell(p(r("a"))) + cell(p(r("b")))).repeat(500))));
    expect(document.getView().body.blocks).toHaveLength(5001);
  });
});

describe("caller limits", () => {
  const three = p(r("one")) + p(r("two")) + p(r("three"));

  it("applies each limit at its exact boundary", async () => {
    const bytes = await bytesOf(three + tbl(row(cell(p(r("a"))) + cell(p(r("b")))) + row(cell(p(r("c"))) + cell(p(r("d"))))));
    // Three paragraphs, a table and its four cell paragraphs.
    expect(await refusedBy(bytes, { maxBlocks: 8, maxTableRows: 2, maxTableCells: 4 })).toBe("opened");
    expect(await refusedBy(bytes, { maxBlocks: 7 })).toBe("maxBlocks");
    expect(await refusedBy(bytes, { maxTableRows: 1 })).toBe("maxTableRows");
    expect(await refusedBy(bytes, { maxTableCells: 3 })).toBe("maxTableCells");
  });

  it("counts the nodes and the characters of all parts together", async () => {
    const header = p(r("head"));
    const alone = await bytesOf(three);
    const withHeaders = await bytesOf(three, { rId7: header, rId8: header, rId9: header });
    // The main part has 15 nodes and each header 6; every part is under 1,000 characters.
    expect(await refusedBy(alone, { maxNodes: 15 })).toBe("opened");
    expect(await refusedBy(alone, { maxNodes: 14 })).toBe("maxNodes");
    expect(await refusedBy(withHeaders, { maxNodes: 32 })).toBe("maxNodes");
    expect(await refusedBy(withHeaders, { maxNodes: 33 })).toBe("opened");
    expect(await refusedBy(alone, { maxXmlChars: 1000 })).toBe("opened");
    expect(await refusedBy(withHeaders, { maxXmlChars: 1000 })).toBe("maxXmlChars");
    expect(await refusedBy(withHeaders, { maxXmlChars: 100_000 })).toBe("opened");
  });

  it("still takes the ZIP limits in the same object", async () => {
    const bytes = await bytesOf(three);
    await expect(openDocx(bytes, { maxEntryBytes: 10 })).rejects.toSatisfy((error) => isOfficeError(error, "zip_limit_exceeded"));
  });

  it("refuses limits that are not positive integers", async () => {
    const bytes = await bytesOf(three);
    for (const limits of [{ maxBlocks: 0 }, { maxNodes: -1 }, { maxTableRows: Number.NaN }, { maxTableCells: 1.5 }, { maxXmlChars: "9" as unknown as number }]) {
      await expect(openDocx(bytes, limits)).rejects.toSatisfy((error) => isOfficeError(error, "invalid_argument"));
    }
  });

  it("refuses an edit that would pass a limit and leaves the document as it was", async () => {
    const document = await openDocx(await bytesOf(three), { maxBlocks: 3 });
    const last = document.getView().body.blocks[2]!;
    let caught: unknown;
    try {
      document.applyOps([{ type: "insertParagraphAfter", blockId: last.id, text: "four" }], OPTIONS);
    } catch (error) {
      caught = error;
    }
    expect(isOfficeError(caught, "limit_exceeded")).toBe(true);
    expect(document.getPlainText()).toBe("one\ntwo\nthree\n");
    // The document still takes edits that stay within the limit.
    document.applyOps([{ type: "insertText", at: { blockId: last.id, offset: 5 }, text: "!" }], OPTIONS);
    expect(document.getPlainText()).toBe("one\ntwo\nthree!\n");
  });
});

describe("exports of a document at the limits", () => {
  /** Best of three, so a busy machine does not decide the result. */
  function fastest(action: () => unknown): number {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      action();
      best = Math.min(best, performance.now() - started);
    }
    return best;
  }

  it("writes a table in time proportional to its rows", async () => {
    const table = (rows: number): Promise<Uint8Array> => bytesOf(`${tbl(row(cell(p(r("x")))).repeat(rows))}<w:p/>`);
    const small = await openDocx(await table(2000));
    const large = await openDocx(await table(16_000));
    const smallTime = fastest(() => toHtml(small, { view: "final" }));
    const largeTime = fastest(() => toHtml(large, { view: "final" }));
    // Eight times the rows: about eight times the work, and 64 times when every row searches the table again.
    expect(largeTime).toBeLessThan(Math.max(smallTime, 1) * 24);
  });

  it("writes a very long run without building it character by character", async () => {
    const text = "lorem ipsum &amp; dolor\tsit ".repeat(150_000);
    const document = await openDocx(await bytesOf(p(r(text))));
    const started = performance.now();
    const html = toHtml(document);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(html).toContain('lorem ipsum &amp; dolor<span class="tab">\t</span>sit lorem');
    expect(html.split('<span class="tab">').length - 1).toBe(150_000);
  });
});
