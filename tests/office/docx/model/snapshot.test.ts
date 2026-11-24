import { describe, expect, it } from "vitest";

import type { ParagraphBlock } from "../../../../packages/office/src/api/docx.js";
import { getDocxIndex, liftToParagraph, splitRunAt } from "../../../../packages/office/src/docx/internal.js";
import { find, remove } from "../../../../packages/office/src/xml/index.js";
import { buildDocument, p, r } from "./build.js";
import { openFixture, paragraphStarting } from "./helpers.js";

describe("snapshots and identity", () => {
  it("keeps revision ids through an edit and its undo, also when the snapshot came before the first listing", async () => {
    const document = await openFixture("tracked.docx");
    const index = getDocxIndex(document);
    const snapshot = document.snapshot();
    const before = document.listRevisions();
    const view = document.getView();

    const block = paragraphStarting(view.body, "The supplier shall");
    liftToParagraph(index, splitRunAt(index, { blockId: block.id, offset: 35 }).point);
    liftToParagraph(index, splitRunAt(index, { blockId: block.id, offset: 58 }).point);
    expect(document.listRevisions()).toEqual(before);

    document.restore(snapshot);
    expect(document.listRevisions()).toEqual(before);
    expect(document.getView()).toEqual(view);
  });

  it("restores the revision ids of each snapshot after an edit regrouped the revisions", () => {
    const who = 'w:author="Sam" w:date="2026-02-01T00:00:00Z"';
    const ins = (text: string, id: number): string => `<w:ins w:id="${id}" ${who}>${r(text)}</w:ins>`;
    const document = buildDocument({
      body: p(ins("one", 1), `<w:rPr><w:ins w:id="2" ${who}/></w:rPr>`) + p(ins("two", 3)) + p(r("plain")),
    });
    const index = getDocxIndex(document);
    const [first, second] = document.getView().body.blocks as [ParagraphBlock, ParagraphBlock];
    const whole = document.snapshot();
    const joined = document.listRevisions().map((revision) => [revision.id, revision.text]);
    expect(joined).toEqual([[joined[0]?.[0], "one\ntwo"]]);

    // Taking the tracked paragraph mark away leaves two separate insertions.
    const firstElement = index.requireBlock(first.id).element;
    remove(find(find(firstElement, "w:pPr")!, "w:ins")!);
    index.markDirty(firstElement);
    const parted = document.snapshot();
    const apart = document.listRevisions().map((revision) => [revision.id, revision.text]);
    expect(apart).toEqual([
      [joined[0]?.[0], "one"],
      [apart[1]?.[0], "two"],
    ]);
    expect(apart[1]?.[0]).not.toBe(joined[0]?.[0]);

    // Change the second paragraph, then go back to each snapshot in turn.
    splitRunAt(index, { blockId: second.id, offset: 1 });
    expect(document.listRevisions().map((revision) => [revision.id, revision.text])).toEqual(apart);
    document.restore(parted);
    expect(document.listRevisions().map((revision) => [revision.id, revision.text])).toEqual(apart);
    document.restore(whole);
    expect(document.listRevisions().map((revision) => [revision.id, revision.text])).toEqual(joined);
    document.restore(parted);
    expect(document.listRevisions().map((revision) => [revision.id, revision.text])).toEqual(apart);
    expect((document.getBlock(first.id) as ParagraphBlock).markRevision).toBeNull();
  });

  it("keeps field ids and block ids of unchanged and of restored content", async () => {
    const document = await openFixture("links-fields.docx");
    const index = getDocxIndex(document);
    const view = document.getView();
    const snapshot = document.snapshot();
    const block = paragraphStarting(view.body, "As explained in");
    splitRunAt(index, { blockId: block.id, offset: 20 });
    expect(document.getView()).toEqual(view);
    remove(index.requireBlock(block.id).element);
    index.markDirty(index.story("body")!.container);
    expect(document.getBlock(block.id)).toBeNull();
    expect(document.getView().body.blocks).toHaveLength(view.body.blocks.length - 1);
    document.restore(snapshot);
    expect(document.getView()).toEqual(view);
  });
});
