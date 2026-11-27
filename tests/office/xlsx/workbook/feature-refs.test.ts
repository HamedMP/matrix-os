/**
 * Data validations, conditional formats and in-workbook links that point at
 * another sheet.
 *
 * Outcome protected: a dropdown keeps offering the same list, and a rule
 * keeps comparing with the same cell, after the sheet they point at is
 * renamed, removed or has rows inserted. Fault detected: only cell formulas
 * and defined names were rewritten.
 */

import { describe, expect, it } from "vitest";
import { openXlsx } from "../../../../packages/office/src/xlsx/index.js";
import { buildXlsx, sheetId } from "./helpers.js";

const X14 = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main";
const XM = "http://schemas.microsoft.com/office/excel/2006/main";

const ORDERS_AFTER =
  '<conditionalFormatting sqref="C2:C20"><cfRule type="expression" priority="1"><formula>C2&gt;Lists!$C$1</formula></cfRule></conditionalFormatting>' +
  '<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="B2:B20"><formula1>Lists!$A$2:$A$5</formula1></dataValidation></dataValidations>' +
  '<hyperlinks><hyperlink ref="F1" location="Lists!A1" display="see lists"/><hyperlink ref="F2" location="B5"/></hyperlinks>' +
  `<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="${X14}"><x14:dataValidations count="1" xmlns:xm="${XM}">` +
  "<x14:dataValidation type=\"list\"><x14:formula1><xm:f>Lists!$A$2:$A$5</xm:f></x14:formula1><xm:sqref>D2:D20</xm:sqref></x14:dataValidation>" +
  "</x14:dataValidations></ext></extLst>";

async function book(): Promise<Uint8Array> {
  return buildXlsx({
    sheets: [
      { name: "Orders", rows: '<row r="1"><c r="A1"><f>Lists!C1*2</f><v>200</v></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>pro</t></is></c></row>', after: ORDERS_AFTER },
      { name: "Lists", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>Plans</t></is></c><c r="C1"><v>100</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>free</t></is></c></row>' },
    ],
  });
}

async function ordersXml(bytes: Uint8Array): Promise<string> {
  return (await openXlsx(bytes)).package.getPartText("/xl/worksheets/sheet1.xml");
}

describe("feature formulas that point at another sheet", () => {
  it("follow a rename", async () => {
    const workbook = await openXlsx(await book());
    workbook.renameSheet(sheetId(workbook, "Lists"), "Plan List");
    const xml = await ordersXml(await workbook.save());
    expect(xml).toContain("<formula1>'Plan List'!$A$2:$A$5</formula1>");
    expect(xml).toContain("<formula>C2&gt;'Plan List'!$C$1</formula>");
    expect(xml).toContain(`location="'Plan List'!A1"`);
    expect(xml).toContain("<xm:f>'Plan List'!$A$2:$A$5</xm:f>");
    expect(xml).not.toContain("Lists!");
  });

  it("become #REF! when the sheet is removed", async () => {
    const workbook = await openXlsx(await book());
    workbook.removeSheet(sheetId(workbook, "Lists"));
    const xml = await ordersXml(await workbook.save());
    expect(xml).toContain("<formula1>#REF!</formula1>");
    expect(xml).toContain("<formula>C2&gt;#REF!</formula>");
    expect(xml).toContain('location="#REF!"');
    expect(xml).not.toContain("Lists!");
  });

  it("follow rows inserted and deleted on the other sheet", async () => {
    const workbook = await openXlsx(await book());
    const lists = sheetId(workbook, "Lists");
    workbook.insertRows(lists, 0, 2);
    let xml = await ordersXml(await workbook.save());
    expect(xml).toContain("<formula1>Lists!$A$4:$A$7</formula1>");
    expect(xml).toContain("<formula>C2&gt;Lists!$C$3</formula>");
    expect(xml).toContain('location="Lists!A3"');
    expect(xml).toContain("<xm:f>Lists!$A$4:$A$7</xm:f>");
    // The ranges on the sheet that holds the rules did not move.
    expect(xml).toContain('sqref="B2:B20"');
    workbook.deleteRows(lists, 0, 3);
    xml = await ordersXml(await workbook.save());
    expect(xml).toContain("<formula1>Lists!$A$1:$A$4</formula1>");
    expect(xml).toContain("<formula>C2&gt;#REF!</formula>");
  });

  it("move once with rows inserted on their own sheet", async () => {
    const workbook = await openXlsx(await book());
    workbook.insertRows(sheetId(workbook, "Orders"), 0, 1);
    const xml = await ordersXml(await workbook.save());
    expect(xml).toContain('sqref="C3:C21"');
    expect(xml).toContain("<formula>C3&gt;Lists!$C$1</formula>");
    expect(xml).toContain('sqref="B3:B21"');
    expect(xml).toContain("<formula1>Lists!$A$2:$A$5</formula1>");
    expect(xml).toContain('<hyperlink ref="F2" location="Lists!A1"');
    expect(xml).toContain('<hyperlink ref="F3" location="B6"/>');
    expect(xml).toContain("<xm:sqref>D3:D21</xm:sqref>");
  });

  it("leave a sheet without such features byte for byte as it was", async () => {
    const source = await book();
    const before = await (await openXlsx(source)).package.getPartText("/xl/worksheets/sheet2.xml");
    const workbook = await openXlsx(source);
    workbook.renameSheet(sheetId(workbook, "Orders"), "Sales");
    const saved = await openXlsx(await workbook.save());
    expect(await saved.package.getPartText("/xl/worksheets/sheet2.xml")).toBe(before);
  });
});
