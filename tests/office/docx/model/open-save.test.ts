import { describe, expect, it } from "vitest";

import type { DocxModule } from "../../../../packages/office/src/api/docx.js";
import * as docx from "../../../../packages/office/src/docx/index.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { openPackage, parseZip } from "../../../../packages/office/src/opc/index.js";
import { DOCX_FIXTURES, loadFixture, openFixture } from "./helpers.js";

describe("openDocx", () => {
  it("exports the values the DocxModule contract names", () => {
    const contract: DocxModule = docx;
    expect(typeof contract.openDocx).toBe("function");
    expect(typeof contract.createDocx).toBe("function");
    expect(typeof contract.compareDocx).toBe("function");
  });

  it.each(DOCX_FIXTURES)("%s opens and yields a JSON-safe view with a body", async (name) => {
    const document = await openFixture(name);
    const view = document.getView();
    expect(view.body.kind).toBe("body");
    expect(view.body.blocks.length).toBeGreaterThan(0);
    expect(view.sections.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(document.package.hasPart("/word/document.xml")).toBe(true);
  });

  it.each(DOCX_FIXTURES)("%s gives the same block and story ids every time it is opened", async (name) => {
    const first = (await openFixture(name)).getView();
    const second = (await openFixture(name)).getView();
    expect(second).toEqual(first);
  });

  it.each(DOCX_FIXTURES)("%s saved without edits keeps every part byte for byte", async (name) => {
    const source = loadFixture(name);
    const document = await openFixture(name);
    // Reading the whole model must not make the document dirty.
    document.getView();
    document.listRevisions();
    document.listComments();
    document.getOutline();
    document.getDefinedTerms();
    document.getCrossReferences();
    document.getPlainText();
    document.getProperties();
    const snapshot = document.snapshot();
    document.restore(snapshot);

    const saved = await document.save();
    const before = await openPackage(source);
    const after = await openPackage(saved);
    const names = before.listParts({ includeRelationships: true }).map((part) => part.name);
    expect(after.listParts({ includeRelationships: true }).map((part) => part.name)).toEqual(names);
    for (const part of names) {
      const original = Buffer.from(await before.getPartBytes(part));
      expect(Buffer.from(await after.getPartBytes(part)).equals(original), part).toBe(true);
    }
    // Untouched entries are not even recompressed.
    const storedBefore = new Map(parseZip(source).records.map((record) => [record.name, record]));
    for (const record of parseZip(saved).records) {
      const original = storedBefore.get(record.name);
      expect(original, record.name).toBeDefined();
      expect(Buffer.from(record.compressed).equals(Buffer.from(original!.compressed)), record.name).toBe(true);
      expect(record.crc32, record.name).toBe(original!.crc32);
    }
    // The handle stays usable and saving again is stable.
    expect(Buffer.from(await document.save()).equals(Buffer.from(saved))).toBe(true);
  });

  it("rejects a workbook as an unsupported format", async () => {
    await expect(docx.openDocx(loadFixture("basic.xlsx"))).rejects.toSatisfy((error) =>
      isOfficeError(error, "unsupported_format"),
    );
  });

  it("rejects bytes that are not a ZIP archive", async () => {
    await expect(docx.openDocx(new TextEncoder().encode("plain text"))).rejects.toSatisfy((error) =>
      isOfficeError(error, "not_a_zip"),
    );
  });

  it("passes ZIP limits through to the package layer", async () => {
    await expect(docx.openDocx(loadFixture("basic.docx"), { maxEntries: 2 })).rejects.toSatisfy((error) =>
      isOfficeError(error, "zip_limit_exceeded"),
    );
  });

  it("reads the core properties", async () => {
    const document = await openFixture("basic.docx");
    expect(document.getProperties()).toEqual({
      title: "Basic formatting sample",
      creator: "Matrix OS fixtures",
      lastModifiedBy: "Matrix OS fixtures",
      created: "2026-01-01T00:00:00Z",
      modified: "2026-01-01T00:00:00Z",
    });
  });
});
