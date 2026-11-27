import { describe, expect, it } from "vitest";

import { compareDocx, compareDocxDetailed } from "../../../../packages/office/src/docx/index.js";
import { OPTIONS, buildDocx, describeRevisions, p, r, reopen } from "./helpers.js";

/*
 * An equation or a symbol counts as one character in the comparison. Two of
 * them are the same only when their content is the same, so an edited
 * equation or a different symbol shows up as a replacement even when the
 * text around it did not change.
 */

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";

const equation = (text: string): string =>
  `<m:oMath xmlns:m="${M}"><m:r><m:t>${text}</m:t></m:r></m:oMath>`;

const symbol = (char: string, font = "Symbol"): string => `<w:r><w:sym w:font="${font}" w:char="${char}"/></w:r>`;

const kinds = (revisions: Array<[string, string, string]>): string[] => revisions.map(([kind]) => kind);

describe("comparing equations and symbols", () => {
  it("sees an unchanged equation as unchanged and an edited one as a replacement", async () => {
    const original = await buildDocx({ body: p(r("Energy is ") + equation("E=mc^2") + r(" in short.")) });
    const same = await buildDocx({ body: p(r("Energy is ") + equation("E=mc^2") + r(" in short.")) });
    expect((await compareDocxDetailed(original, same, OPTIONS)).summary.identical).toBe(true);

    const edited = await buildDocx({ body: p(r("Energy is ") + equation("E=mc^3") + r(" in short.")) });
    expect((await compareDocxDetailed(original, edited, OPTIONS)).summary.identical).toBe(false);
    const document = await reopen(await compareDocx(original, edited, OPTIONS));
    expect(kinds(describeRevisions(document)).sort()).toEqual(["delete", "insert"]);
  });

  it("sees a symbol with another character or font as a replacement", async () => {
    const original = await buildDocx({ body: p(r("Tick ") + symbol("F0FC") + r(" done.")) });
    const same = await buildDocx({ body: p(r("Tick ") + symbol("F0FC") + r(" done.")) });
    expect((await compareDocxDetailed(original, same, OPTIONS)).summary.identical).toBe(true);

    const otherChar = await buildDocx({ body: p(r("Tick ") + symbol("F0FB") + r(" done.")) });
    expect((await compareDocxDetailed(original, otherChar, OPTIONS)).summary.identical).toBe(false);
    const document = await reopen(await compareDocx(original, otherChar, OPTIONS));
    expect(kinds(describeRevisions(document)).sort()).toEqual(["delete", "insert"]);

    const otherFont = await buildDocx({ body: p(r("Tick ") + symbol("F0FC", "Wingdings") + r(" done.")) });
    expect((await compareDocxDetailed(original, otherFont, OPTIONS)).summary.identical).toBe(false);
  });
});
