/**
 * Rejecting a proposed deletion of rows or columns.
 *
 * Outcome protected: an owner who says no to a deletion gets the sheet back
 * as it was, not only its cells. Fault detected: the table range, the ranges
 * of validations and conditional formats, links, notes, array formulas and
 * row and column attributes stayed as the deletion had left them, while the
 * result reported nothing stale.
 */

import { describe, expect, it } from "vitest";
import { openPackage } from "../../../../packages/office/src/opc/index.js";
import { openXlsx, parseA1Range } from "../../../../packages/office/src/xlsx/index.js";
import { buildXlsx } from "../workbook/helpers.js";
import { AGENT, a1, at, changes, sheetId } from "./helpers.js";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

const FEATURES =
  '<autoFilter ref="A1:E9"/>' +
  '<conditionalFormatting sqref="C2:C9"><cfRule type="expression" priority="1"><formula>C2&gt;Limits!$A$1</formula></cfRule></conditionalFormatting>' +
  '<conditionalFormatting sqref="E8:E9"><cfRule type="expression" priority="2"><formula>E8&gt;Limits!$A$1</formula></cfRule></conditionalFormatting>' +
  '<dataValidations count="2"><dataValidation type="list" sqref="B2:B9"><formula1>"a,b"</formula1></dataValidation>' +
  '<dataValidation type="whole" sqref="H2:H9"><formula1>1</formula1><formula2>9</formula2></dataValidation></dataValidations>' +
  '<hyperlinks><hyperlink ref="I2" location="Limits!A1"/><hyperlink ref="I8" location="Limits!A1"/></hyperlinks>';

const COMMENTS =
  `<comments xmlns="${MAIN}"><authors><author>Rae</author></authors><commentList>` +
  '<comment ref="A8" authorId="0"><text><t>last but one</t></text></comment></commentList></comments>';

async function featureBook(): Promise<Uint8Array> {
  let rows = '<row r="1">' + ["A", "B", "C", "D", "E"].map((c, i) => `<c r="${c}1" t="inlineStr"><is><t>H${i + 1}</t></is></c>`).join("") + "</row>";
  for (let r = 2; r <= 9; r++) {
    const attrs = r === 3 ? ' s="1" customFormat="1"' : r === 8 ? ' hidden="1"' : "";
    rows +=
      `<row r="${r}"${attrs}>` +
      ["A", "B", "C", "D", "E"].map((c, i) => `<c r="${c}${r}"><v>${r * 10 + i}</v></c>`).join("") +
      `<c r="H${r}"><v>${r}</v></c><c r="I${r}" t="inlineStr"><is><t>link</t></is></c></row>`;
  }
  rows += '<row r="12"><c r="A12"><f t="array" ref="A12:B13">A2:B3*2</f><v>40</v></c><c r="B12"><v>42</v></c></row>';
  rows += '<row r="13"><c r="A13"><v>60</v></c><c r="B13"><v>62</v></c></row>';
  const bytes = await buildXlsx({
    sheets: [
      { name: "Orders", rows, before: '<cols><col min="8" max="8" width="14" customWidth="1" style="3"/></cols>', after: FEATURES },
      { name: "Limits", rows: '<row r="1"><c r="A1"><v>50</v></c></row>' },
    ],
  });
  const pkg = await openPackage(bytes);
  const sheet = "/xl/worksheets/sheet1.xml";
  const columns = [1, 2, 3, 4, 5].map((n) => `<tableColumn id="${n}" name="H${n}"/>`).join("");
  pkg.setPart(
    "/xl/tables/table1.xml",
    `<table xmlns="${MAIN}" id="1" name="OrdersTable" displayName="OrdersTable" ref="A1:E9" totalsRowShown="0"><autoFilter ref="A1:E9"/><tableColumns count="5">${columns}</tableColumns></table>`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml",
  );
  const table = pkg.addRelationship(sheet, { type: `${REL}/table`, target: "../tables/table1.xml" });
  pkg.setPart("/xl/comments1.xml", COMMENTS, "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml");
  pkg.addRelationship(sheet, { type: `${REL}/comments`, target: "../comments1.xml" });
  const text = await pkg.getPartText(sheet);
  pkg.setPart(sheet, text.replace("</worksheet>", `<tableParts count="1"><tablePart r:id="${table.id}"/></tableParts></worksheet>`));
  return pkg.save();
}

interface Shape {
  features: string;
  table: string;
  comments: string;
  cols: string;
  row3: string;
  row8: string;
}

async function shape(bytes: Uint8Array): Promise<Shape> {
  const pkg = (await openXlsx(bytes)).package;
  const sheet = await pkg.getPartText("/xl/worksheets/sheet1.xml");
  return {
    features: /<autoFilter.*<\/hyperlinks>/.exec(sheet)?.[0] ?? "",
    table: /<table [^>]*>/.exec(await pkg.getPartText("/xl/tables/table1.xml"))?.[0] ?? "",
    comments: await pkg.getPartText("/xl/comments1.xml"),
    cols: /<cols>.*<\/cols>/.exec(sheet)?.[0] ?? "",
    row3: /<row r="3"[^>]*>/.exec(sheet)?.[0] ?? "",
    row8: /<row r="8"[^>]*>/.exec(sheet)?.[0] ?? "",
  };
}

describe("rejecting a proposed deletion puts the sheet back", () => {
  it("after the last rows of a table and of every range were deleted", async () => {
    const source = await featureBook();
    const before = await shape(source);
    const workbook = await openXlsx(source);
    const orders = sheetId(workbook, "Orders");
    workbook.beginProposal(AGENT);
    workbook.deleteRows(orders, 7, 2);
    workbook.endProposal();
    const during = await shape(await workbook.save());
    expect(during.table).toContain('ref="A1:E7"');
    expect(during.features).not.toContain("E8:E9");
    expect(during.comments).not.toContain("last but one");
    const result = workbook.rejectChanges("all");
    expect(result.stale).toEqual([]);
    expect(at(workbook, "Orders", "A9").value).toBe(90);
    expect(await shape(await workbook.save())).toEqual(before);
    expect(changes(workbook)).toEqual([]);
  });

  it("after rows with their own attributes were deleted", async () => {
    const source = await featureBook();
    const before = await shape(source);
    const workbook = await openXlsx(source);
    workbook.beginProposal(AGENT);
    workbook.deleteRows(sheetId(workbook, "Orders"), 2, 1);
    workbook.endProposal();
    workbook.rejectChanges("all");
    const after = await shape(await workbook.save());
    expect(after.row3).toBe(before.row3);
    expect(after).toEqual(before);
  });

  it("after columns with a validation, links and a column format were deleted", async () => {
    const source = await featureBook();
    const before = await shape(source);
    const workbook = await openXlsx(source);
    const orders = sheetId(workbook, "Orders");
    workbook.beginProposal(AGENT);
    workbook.deleteColumns(orders, 7, 2);
    workbook.endProposal();
    const during = await shape(await workbook.save());
    expect(during.features).not.toContain("hyperlink");
    expect(during.cols).toBe("");
    expect(workbook.rejectChanges("all").stale).toEqual([]);
    expect(at(workbook, "Orders", "I2").value).toBe("link");
    expect(await shape(await workbook.save())).toEqual(before);
  });

  it("after the rows of an array formula were deleted", async () => {
    const workbook = await openXlsx(await featureBook());
    const orders = sheetId(workbook, "Orders");
    workbook.recalc();
    workbook.beginProposal(AGENT);
    workbook.deleteRows(orders, 11, 2);
    workbook.endProposal();
    workbook.recalc();
    expect(at(workbook, "Orders", "A12").formula).toBeNull();
    expect(workbook.rejectChanges("all").stale).toEqual([]);
    expect(at(workbook, "Orders", "A12")).toMatchObject({ formula: "A2:B3*2", value: 40, arrayRange: parseA1Range("A12:B13") });
    expect(at(workbook, "Orders", "B13")).toMatchObject({ formula: null, value: 62, arrayRange: parseA1Range("A12:B13") });
    const reopened = await openXlsx(await workbook.save());
    expect(at(reopened, "Orders", "B13").arrayRange).toEqual(parseA1Range("A12:B13"));
  });

  it("in a later session, from the saved file", async () => {
    const source = await featureBook();
    const before = await shape(source);
    const first = await openXlsx(source);
    first.beginProposal(AGENT);
    first.deleteRows(sheetId(first, "Orders"), 7, 2);
    first.endProposal();
    const second = await openXlsx(await first.save());
    expect(changes(second)).toHaveLength(1);
    expect(second.rejectChanges("all").stale).toEqual([]);
    expect(await shape(await second.save())).toEqual(before);
  });

  it("with the names of sheets as they are now", async () => {
    const workbook = await openXlsx(await featureBook());
    const orders = sheetId(workbook, "Orders");
    workbook.setFormula(orders, a1("D9"), "Limits!A1+1");
    workbook.recalc();
    workbook.beginProposal(AGENT);
    workbook.deleteRows(orders, 7, 2);
    workbook.endProposal();
    workbook.renameSheet(sheetId(workbook, "Limits"), "Caps");
    workbook.rejectChanges("all");
    expect(at(workbook, "Orders", "D9")).toMatchObject({ formula: "Caps!A1+1", value: 51 });
    const after = await shape(await workbook.save());
    expect(after.features).toContain('sqref="E8:E9"><cfRule type="expression" priority="2"><formula>E8&gt;Caps!$A$1</formula>');
    expect(after.features).toContain('<hyperlink ref="I8" location="Caps!A1"/>');
    expect(after.features).not.toContain("Limits!");
  });
});

describe("rejecting a proposed deletion keeps what the cells carried", () => {
  const RICH = '<c r="A2" t="inlineStr" cm="1"><is><r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> text</t></r></is></c>';
  async function richBook(): Promise<Uint8Array> {
    return buildXlsx({
      sheets: [
        {
          name: "S",
          rows:
            '<row r="1"><c r="A1"><v>1</v></c></row>' +
            `<row r="2">${RICH}<c r="B2" t="s" vm="1"><v>0</v></c><c r="C2" ph="1"><v>5</v></c><c r="D2" t="s"><v>1</v></c></row>` +
            '<row r="3"><c r="A3"><v>3</v></c></row>',
        },
      ],
      sharedStrings: "<si><r><rPr><i/></rPr><t>Ital</t></r><r><t>ic</t></r></si><si><t>plain</t></si>",
    });
  }
  const row2 = async (bytes: Uint8Array): Promise<string> =>
    /<row r="2".*?<\/row>/.exec(await (await openXlsx(bytes)).package.getPartText("/xl/worksheets/sheet1.xml"))?.[0] ?? "";
  const expectRestored = (row: string): void => {
    expect(row).toContain(RICH);
    expect(row).toContain('<c r="B2" t="inlineStr" vm="1"><is><r><rPr><i/></rPr><t>Ital</t></r><r><t>ic</t></r></is></c>');
    expect(row).toContain('<c r="C2" ph="1"><v>5</v></c>');
    expect(row).toContain('<c r="D2" t="s"><v>1</v></c>');
  };

  it("rich text, cell metadata and phonetic flags of deleted rows", async () => {
    const workbook = await openXlsx(await richBook());
    workbook.beginProposal(AGENT);
    workbook.deleteRows(sheetId(workbook, "S"), 1, 1);
    workbook.endProposal();
    expect(workbook.rejectChanges("all").stale).toEqual([]);
    expect(at(workbook, "S", "A2").value).toBe("Bold text");
    expect(at(workbook, "S", "B2").value).toBe("Italic");
    expectRestored(await row2(await workbook.save()));
  });

  it("rich text of deleted columns, and in a later session from the saved file", async () => {
    const first = await openXlsx(await richBook());
    first.beginProposal(AGENT);
    first.deleteColumns(sheetId(first, "S"), 0, 3);
    first.endProposal();
    const second = await openXlsx(await first.save());
    expect(second.rejectChanges("all").stale).toEqual([]);
    expectRestored(await row2(await second.save()));
  });
});
