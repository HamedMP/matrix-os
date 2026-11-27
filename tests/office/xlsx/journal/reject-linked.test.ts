/**
 * Rejecting a proposed deletion puts back what other sheets' features pointed at.
 *
 * Outcome protected: an owner who says no to a deletion gets back the links,
 * conditional formats and data validations of other sheets that pointed into
 * the deleted rows or columns. Fault detected: only the edited sheet's
 * features were kept, so a link on `Orders` to `Lists!A1` stayed `#REF!` after
 * the deletion of row 1 on `Lists` was rejected, while the result reported
 * nothing stale.
 */

import { describe, expect, it } from "vitest";
import { openXlsx } from "../../../../packages/office/src/xlsx/index.js";
import { MAX_FEATURE_TEXT } from "../../../../packages/office/src/xlsx/workbook/features.js";
import { buildXlsx } from "../workbook/helpers.js";
import { AGENT, changes, codeOf, sheetId } from "./helpers.js";

const FEATURES =
  '<conditionalFormatting sqref="A1:A3"><cfRule type="expression" priority="1"><formula>A1&gt;Lists!$A$1</formula></cfRule></conditionalFormatting>' +
  '<dataValidations count="1"><dataValidation type="list" sqref="B1:B3"><formula1>Lists!$A$1:$A$3</formula1></dataValidation></dataValidations>' +
  '<hyperlinks><hyperlink ref="C1" location="Lists!A1"/><hyperlink ref="C2" location="Lists!B2"/></hyperlinks>';

const LISTS = '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row>';

function linkedBook(features = FEATURES): Promise<Uint8Array> {
  return buildXlsx({
    sheets: [
      { name: "Orders", rows: '<row r="1"><c r="A1"><v>5</v></c></row>', after: features },
      { name: "Lists", rows: LISTS },
    ],
  });
}

async function ordersFeatures(bytes: Uint8Array): Promise<string> {
  const sheet = await (await openXlsx(bytes)).package.getPartText("/xl/worksheets/sheet1.xml");
  return /<conditionalFormatting.*<\/hyperlinks>/.exec(sheet)?.[0] ?? "";
}

describe("rejecting a proposed deletion puts back other sheets' features", () => {
  it("links, conditional formats and validations that pointed into the deleted rows", async () => {
    const source = await linkedBook();
    const before = await ordersFeatures(source);
    const workbook = await openXlsx(source);
    // Defined names were already kept; this checks they still come back alongside.
    workbook.setDefinedName({ name: "First", scope: null, refersTo: "Lists!$A$1" });
    workbook.beginProposal(AGENT);
    workbook.deleteRows(sheetId(workbook, "Lists"), 0, 1);
    workbook.endProposal();
    const during = await ordersFeatures(await workbook.save());
    expect(during).toContain('location="#REF!"');
    expect(during).toContain("A1&gt;#REF!");
    expect(workbook.rejectChanges("all").stale).toEqual([]);
    expect(await ordersFeatures(await workbook.save())).toBe(before);
    expect(workbook.listDefinedNames().find((name) => name.name === "First")?.refersTo).toBe("Lists!$A$1");
    expect(changes(workbook)).toEqual([]);
  });

  it("in a later session, from the saved file", async () => {
    const source = await linkedBook();
    const before = await ordersFeatures(source);
    const first = await openXlsx(source);
    first.beginProposal(AGENT);
    first.deleteColumns(sheetId(first, "Lists"), 0, 1);
    first.endProposal();
    const second = await openXlsx(await first.save());
    expect(changes(second)).toHaveLength(1);
    expect(second.rejectChanges("all").stale).toEqual([]);
    expect(await ordersFeatures(await second.save())).toBe(before);
  });

  it("with the names of sheets as they are now", async () => {
    const workbook = await openXlsx(await linkedBook());
    workbook.beginProposal(AGENT);
    workbook.deleteRows(sheetId(workbook, "Lists"), 0, 1);
    workbook.endProposal();
    workbook.renameSheet(sheetId(workbook, "Lists"), "Values");
    expect(workbook.rejectChanges("all").stale).toEqual([]);
    const after = await ordersFeatures(await workbook.save());
    expect(after).toContain('<hyperlink ref="C1" location="Values!A1"/>');
    expect(after).toContain("A1&gt;Values!$A$1");
    expect(after).not.toContain("#REF!");
  });

  // Fault detected: without a bound, many such links could make a proposal too large to keep. Before and after
  // together pass the bound here, either alone does not.
  it("refuses up front a deletion whose rewritten links are too large to keep", async () => {
    const one = '<hyperlink ref="C1" location="Lists!A1"/>';
    const links = `<hyperlinks>${one.repeat(Math.ceil((MAX_FEATURE_TEXT * 0.6) / one.length))}</hyperlinks>`;
    const workbook = await openXlsx(await linkedBook(links));
    const lists = sheetId(workbook, "Lists");
    workbook.beginProposal(AGENT);
    expect(codeOf(() => workbook.deleteRows(lists, 0, 1))).toBe("limit_exceeded");
    workbook.endProposal();
    expect(changes(workbook)).toEqual([]);
    expect(workbook.listSheets().find((sheet) => sheet.id === lists)).toBeDefined();
    const sheet = await (await openXlsx(await workbook.save())).package.getPartText("/xl/worksheets/sheet1.xml");
    expect(sheet).not.toContain("#REF!");
  });
});
