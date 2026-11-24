/**
 * Cell notes and threaded comments when rows and columns move.
 *
 * Outcome protected: a note stays on the cell it was written for. Fault
 * detected: the comment parts kept the old addresses, so a note showed on a
 * neighbouring row after an insertion or a deletion.
 */

import { describe, expect, it } from "vitest";
import { openPackage } from "../../../../packages/office/src/opc/index.js";
import { openXlsx, parseA1 } from "../../../../packages/office/src/xlsx/index.js";
import { buildXlsx, codeOf, sheetId } from "./helpers.js";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

const shape = (id: number, row: number, col: number): string =>
  `<v:shape id="_x0000_s${id}" type="#_x0000_t202" style="position:absolute;visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto">` +
  '<v:fill color2="#ffffe1"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>' +
  `<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${col + 1}, 15, ${row}, 2, ${col + 3}, 15, ${row + 3}, 16</x:Anchor>` +
  `<x:AutoFill>False</x:AutoFill><x:Row>${row}</x:Row><x:Column>${col}</x:Column></x:ClientData></v:shape>`;

const VML = (shapes: string): string =>
  '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
  '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>' +
  '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/></v:shapetype>' +
  `${shapes}</xml>`;

const COMMENTS =
  `<comments xmlns="${MAIN}"><authors><author>Rae</author></authors><commentList>` +
  '<comment ref="A3" authorId="0"><text><t>VIP customer</t></text></comment>' +
  '<comment ref="C5" authorId="0"><text><t>check amount</t></text></comment>' +
  "</commentList></comments>";

const THREADED =
  '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">' +
  '<threadedComment ref="C5" dT="2026-11-23T10:00:00.00" personId="{A}" id="{1}"><text>check amount</text></threadedComment>' +
  '<threadedComment ref="C5" dT="2026-11-23T10:05:00.00" personId="{A}" id="{2}" parentId="{1}"><text>done</text></threadedComment>' +
  "</ThreadedComments>";

async function notedBook(vml: string = VML(shape(1025, 2, 0) + shape(1026, 4, 2))): Promise<Uint8Array> {
  let rows = "";
  for (let r = 1; r <= 6; r++) rows += `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>C${r}</t></is></c><c r="C${r}"><v>${r * 10}</v></c></row>`;
  const pkg = await openPackage(await buildXlsx({ sheets: [{ name: "Orders", rows }, { name: "Other" }] }));
  const sheet = "/xl/worksheets/sheet1.xml";
  pkg.setPart("/xl/comments1.xml", COMMENTS, "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml");
  pkg.setPart("/xl/drawings/vmlDrawing1.vml", vml, "application/vnd.openxmlformats-officedocument.vmlDrawing");
  pkg.setPart("/xl/threadedComments/threadedComment1.xml", THREADED, "application/vnd.ms-excel.threadedcomments+xml");
  pkg.addRelationship(sheet, { type: `${REL}/comments`, target: "../comments1.xml" });
  const drawing = pkg.addRelationship(sheet, { type: `${REL}/vmlDrawing`, target: "../drawings/vmlDrawing1.vml" });
  pkg.addRelationship(sheet, { type: "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment", target: "../threadedComments/threadedComment1.xml" });
  const text = await pkg.getPartText(sheet);
  pkg.setPart(sheet, text.replace("</worksheet>", `<legacyDrawing r:id="${drawing.id}"/></worksheet>`));
  return pkg.save();
}

async function parts(bytes: Uint8Array): Promise<{ comments: string; vml: string; threaded: string }> {
  const pkg = (await openXlsx(bytes)).package;
  return {
    comments: await pkg.getPartText("/xl/comments1.xml"),
    vml: await pkg.getPartText("/xl/drawings/vmlDrawing1.vml"),
    threaded: await pkg.getPartText("/xl/threadedComments/threadedComment1.xml"),
  };
}

const refs = (text: string): string[] => [...text.matchAll(/ ref="([^"]*)"/g)].map((match) => match[1] as string);
const cells = (vml: string): string[] => [...vml.matchAll(/<x:Row>(\d+)<\/x:Row><x:Column>(\d+)<\/x:Column>/g)].map((match) => `${match[1]},${match[2]}`);

describe("notes follow their cells", () => {
  it("when rows are inserted above them", async () => {
    const workbook = await openXlsx(await notedBook());
    const orders = sheetId(workbook, "Orders");
    workbook.insertRows(orders, 1, 2);
    expect(workbook.getCell(orders, parseA1("A5")).value).toBe("C3");
    const after = await parts(await workbook.save());
    expect(refs(after.comments)).toEqual(["A5", "C7"]);
    expect(cells(after.vml)).toEqual(["4,0", "6,2"]);
    expect(refs(after.threaded)).toEqual(["C7", "C7"]);
    // The box of the note moves with the cell.
    expect(after.vml).toContain("<x:Anchor>1, 15, 4, 2, 3, 15, 7, 16</x:Anchor>");
  });

  it("when columns are inserted before them", async () => {
    const workbook = await openXlsx(await notedBook());
    workbook.insertColumns(sheetId(workbook, "Orders"), 1, 1);
    const after = await parts(await workbook.save());
    expect(refs(after.comments)).toEqual(["A3", "D5"]);
    expect(cells(after.vml)).toEqual(["2,0", "4,3"]);
    expect(refs(after.threaded)).toEqual(["D5", "D5"]);
    expect(after.vml).toContain("<x:Anchor>4, 15, 4, 2, 6, 15, 7, 16</x:Anchor>");
  });

  it("and go with a deleted cell while the others move up", async () => {
    const workbook = await openXlsx(await notedBook());
    workbook.deleteRows(sheetId(workbook, "Orders"), 2, 1);
    const after = await parts(await workbook.save());
    expect(refs(after.comments)).toEqual(["C4"]);
    expect(after.comments).not.toContain("VIP customer");
    expect(cells(after.vml)).toEqual(["3,2"]);
    expect(refs(after.threaded)).toEqual(["C4", "C4"]);
  });

  it("stay as they are when another sheet changes, and the parts are not rewritten", async () => {
    const source = await notedBook();
    const before = await parts(source);
    const workbook = await openXlsx(source);
    workbook.insertRows(sheetId(workbook, "Other"), 0, 3);
    workbook.setCell(sheetId(workbook, "Orders"), parseA1("B1"), 1);
    expect(await parts(await workbook.save())).toEqual(before);
  });

  it("refuse to move when the drawing of the notes cannot be read", async () => {
    const workbook = await openXlsx(await notedBook("<xml><v:shape><br></v:shape></xml>"));
    const orders = sheetId(workbook, "Orders");
    expect(codeOf(() => workbook.insertRows(orders, 1, 1))).toBe("invalid_operation");
    expect(workbook.getCell(orders, parseA1("A3")).value).toBe("C3");
    // Everything that does not move cells still works.
    workbook.setCell(orders, parseA1("B1"), 1);
    workbook.insertRows(sheetId(workbook, "Other"), 0, 1);
    expect((await workbook.save()).length).toBeGreaterThan(0);
  });
});
