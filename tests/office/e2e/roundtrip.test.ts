/**
 * Acceptance check 1: a document opened and saved with no edits has
 * byte-identical parts.
 */

import { describe, expect, it } from "vitest";
import type { AgentModule, DocxModule, FormulaModule, OpcModule, RedlineModule, XlsxModule, XmlModule } from "../../../packages/office/src/index.js";
import * as office from "../../../packages/office/src/index.js";
import { openDocx, openXlsx } from "../../../packages/office/src/index.js";
import { DOCX_FIXTURES, XLSX_FIXTURES, changedParts, keepOutput, loadFixture, readParts } from "./helpers.js";

/** Each namespace of the package root against its contract; a module that drifts from `src/api` stops compiling here. */
const contracts: {
  opc: OpcModule;
  xml: XmlModule;
  docx: DocxModule;
  xlsx: XlsxModule;
  formula: FormulaModule;
  redline: RedlineModule;
  agent: AgentModule;
} = office;

describe("the public API", () => {
  it("implements the contract of every module", () => {
    for (const [name, module] of Object.entries(contracts)) {
      for (const [key, value] of Object.entries(module)) expect(value, `${name}.${key}`).toBeDefined();
    }
    expect(contracts.xlsx.MAX_ROWS).toBe(1_048_576);
    expect(contracts.xlsx.MAX_COLS).toBe(16_384);
    expect(contracts.opc.DEFAULT_ZIP_LIMITS).toMatchObject({ maxEntries: 5000 });
  });

  it("exports every module as a namespace and the main entry points by name", () => {
    for (const name of ["opc", "xml", "docx", "xlsx", "formula", "redline", "agent"] as const) {
      expect(Object.keys(office[name]).length, name).toBeGreaterThan(3);
    }
    const contracts = {
      opc: ["openPackage", "createPackage", "DEFAULT_ZIP_LIMITS"],
      xml: ["parseXml", "serializeXml", "cloneDocument"],
      docx: ["openDocx", "createDocx", "compareDocx"],
      xlsx: ["openXlsx", "createXlsx", "parseCsv", "toCsv", "formatValue", "columnLabel", "columnIndex", "parseA1", "formatA1", "parseA1Range", "formatA1Range", "parseSheetRange", "MAX_ROWS", "MAX_COLS"],
      formula: ["parseFormula", "serializeFormula", "evaluate", "collectReferences", "mapReferences", "createFunctionRegistry"],
      redline: ["diffWords", "diffSequences", "createRedline", "loadRedline"],
      agent: ["describeDocx", "describeSheet", "parseAgentEdits", "agentEditInstructions", "toDocxOps", "toSheetEdits", "applySheetEdits"],
    } as const;
    for (const [module, names] of Object.entries(contracts)) {
      const namespace = office[module as keyof typeof contracts] as Record<string, unknown>;
      for (const name of names) expect(namespace[name], `${module}.${name}`).toBeDefined();
    }
    expect(office.openDocx).toBe(office.docx.openDocx);
    expect(office.openXlsx).toBe(office.xlsx.openXlsx);
    expect(office.parseAgentEdits).toBe(office.agent.parseAgentEdits);
    expect(office.isOfficeError(new office.OfficeError("not_found", "x"), "not_found")).toBe(true);
  });
});

describe.each(DOCX_FIXTURES)("%s opened and saved without edits", (name) => {
  it("has byte-identical parts", async () => {
    const source = loadFixture(name);
    const document = await openDocx(source);
    // Reading everything the model offers must not count as an edit.
    document.getView();
    document.listRevisions();
    document.listComments();
    document.getOutline();
    document.getDefinedTerms();
    document.getCrossReferences();
    document.getPlainText();
    const saved = await document.save();
    expect(await changedParts(source, saved)).toEqual([]);
    expect((await readParts(saved)).size).toBeGreaterThan(3);
    // The saved file opens again and reads the same.
    const reopened = await openDocx(saved);
    expect(reopened.getPlainText({ view: "markup" })).toBe(document.getPlainText({ view: "markup" }));
    expect(reopened.listRevisions().length).toBe(document.listRevisions().length);
    keepOutput(`roundtrip-${name}`, saved);
  });
});

describe.each(XLSX_FIXTURES)("%s opened and saved without edits", (name) => {
  it("has byte-identical parts", async () => {
    const source = loadFixture(name);
    const workbook = await openXlsx(source);
    for (const sheet of workbook.listSheets()) if (sheet.dimensions !== null) workbook.getRange(sheet.id, sheet.dimensions);
    workbook.listDefinedNames();
    const saved = await workbook.save();
    expect(await changedParts(source, saved)).toEqual([]);
    const reopened = await openXlsx(saved);
    expect(reopened.listSheets()).toEqual(workbook.listSheets());
    keepOutput(`roundtrip-${name}`, saved);
  });
});
