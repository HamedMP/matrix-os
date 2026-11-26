import { describe, expect, it } from "vitest";
import { AssistantStore } from "../../../../home/apps/docs/src/ui/agent/assistant-store";
import { OWNER, envelope, finalText, scripted, sessionWith } from "./helpers";

async function proposedQuickly() {
  const session = await sessionWith(["The cat sat."]);
  const doc = session.document!;
  const blockId = doc.getView().body.blocks[0]!.id;
  const model = scripted(envelope([{ op: "replaceText", blockId, find: "cat sat", replace: "cat quickly sat" }], "Adds an adverb."));
  const store = new AssistantStore({ session, generate: model.generate, getSelection: () => null, log: () => undefined });
  // As the workspace does: the store sees every change to the document.
  session.onChange((change) => store.documentChanged(change));
  await store.submit("Add an adverb");
  const card = store.getState().cards.find((entry) => entry.type === "edit");
  if (card === undefined || card.type !== "edit") throw new Error("no edit card");
  expect(finalText(doc).trim()).toBe("The cat quickly sat.");
  // The owner types inside the assistant's insertion: the engine splits it in two.
  session.apply([{ type: "insertText", at: { blockId, offset: "The cat qui".length }, text: "XX" }], { track: true, author: OWNER, origin: "editor" });
  expect(finalText(doc).trim()).toBe("The cat quiXXckly sat.");
  expect(doc.listRevisions().filter((revision) => revision.author !== OWNER).length).toBeGreaterThan(1);
  return { session, doc, store, cardId: card.id };
}

describe("an assistant card after the owner typed inside its insertion", () => {
  it("Reject all rejects both halves of the split insertion", async () => {
    const { doc, store, cardId } = await proposedQuickly();
    store.rejectAll(cardId);
    expect(finalText(doc).trim()).toBe("The cat XXsat.");
    expect(doc.listRevisions().filter((revision) => revision.author !== OWNER)).toEqual([]);
    expect(store.view(cardId)).toMatchObject({ status: "rejected", pending: 0 });
  });

  it("Accept all accepts both halves, and the card stays proposed until then", async () => {
    const { doc, store, cardId } = await proposedQuickly();
    expect(store.pending(cardId).length).toBeGreaterThan(1);
    store.acceptAll(cardId);
    expect(doc.listRevisions().filter((revision) => revision.author !== OWNER)).toEqual([]);
    expect(finalText(doc).trim()).toBe("The cat quiXXckly sat.");
  });

  it("one-by-one review resolves the whole change after Enter moved a half into a new paragraph", async () => {
    const { session, doc, store, first, cat } = await twoCardsInOneMinute();
    session.apply([{ type: "splitParagraph", at: { blockId: first, offset: "The cat qui".length } }], { track: true, author: OWNER, origin: "editor" });
    expect(store.startReview(cat)).not.toBeNull();
    expect(store.resolveCurrent("reject")).toBeNull();
    expect(store.pending(cat)).toEqual([]);
    expect(finalText(doc)).not.toContain("ckly");
  });

  it("one-by-one review resolves the whole change, split halves included", async () => {
    const { doc, store, cardId } = await proposedQuickly();
    expect(store.startReview(cardId)).not.toBeNull();
    expect(store.resolveCurrent("reject")).toBeNull();
    expect(doc.listRevisions().filter((revision) => revision.author !== OWNER)).toEqual([]);
    expect(finalText(doc).trim()).toBe("The cat XXsat.");
  });
});

/** Two assistant requests finished in the same minute: their revisions share the author and the date. */
async function twoCardsInOneMinute() {
  const session = await sessionWith(["The cat sat.", "The dog ran."]);
  const doc = session.document!;
  const [first, second] = doc.getView().body.blocks.map((block) => block.id);
  const model = scripted(
    envelope([{ op: "replaceText", blockId: first, find: "cat sat", replace: "cat quickly sat" }]),
    envelope([{ op: "replaceText", blockId: second, find: "dog ran", replace: "dog slowly ran" }]),
  );
  const store = new AssistantStore({ session, generate: model.generate, getSelection: () => null, log: () => undefined });
  session.onChange((change) => store.documentChanged(change));
  await store.submit("Add an adverb to the cat");
  await store.submit("Add an adverb to the dog");
  const [cat, dog] = store.getState().cards.filter((card) => card.type === "edit").map((card) => card.id);
  return { session, doc, store, first: first!, cat: cat!, dog: dog! };
}

describe("two assistant cards of the same minute", () => {
  it("a piece split off the first card's insertion stays with the first card", async () => {
    const { session, doc, store, first, cat, dog } = await twoCardsInOneMinute();
    session.apply([{ type: "insertText", at: { blockId: first, offset: "The cat qui".length }, text: "XX" }], { track: true, author: OWNER, origin: "editor" });
    expect(store.pending(cat)).toHaveLength(2);
    expect(store.pending(dog)).toHaveLength(1);
    // Reject all on the second card leaves the first card's proposal whole.
    store.rejectAll(dog);
    expect(finalText(doc)).toContain("The cat quiXXckly sat.");
    expect(finalText(doc)).toContain("The dog ran.");
    expect(store.view(cat)).toMatchObject({ status: "proposed", pending: 2 });
  });

  it("follows the piece into the new paragraph when the owner presses Enter inside the insertion, and through undo and redo", async () => {
    const { session, store, first, cat, dog } = await twoCardsInOneMinute();
    session.apply([{ type: "splitParagraph", at: { blockId: first, offset: "The cat qui".length } }], { track: true, author: OWNER, origin: "editor" });
    expect(store.pending(cat)).toHaveLength(2);
    expect(store.pending(dog)).toHaveLength(1);
    session.undo();
    expect(store.pending(cat)).toHaveLength(1);
    session.redo();
    expect(store.pending(cat)).toHaveLength(2);
    expect(store.pending(dog)).toHaveLength(1);
  });
});

/** One card with two separate edits in one paragraph. */
async function twoEditsInOneParagraph() {
  const session = await sessionWith(["The cat sat on the mat."]);
  const doc = session.document!;
  const blockId = doc.getView().body.blocks[0]!.id;
  const model = scripted(
    envelope([
      { op: "replaceText", blockId, find: "cat sat", replace: "cat quickly sat" },
      { op: "replaceText", blockId, find: "the mat", replace: "the soft mat" },
    ]),
  );
  const store = new AssistantStore({ session, generate: model.generate, getSelection: () => null, log: () => undefined });
  session.onChange((change) => store.documentChanged(change));
  await store.submit("Add two words");
  const card = store.getState().cards.find((entry) => entry.type === "edit");
  if (card === undefined || card.type !== "edit") throw new Error("no edit card");
  expect(card.changes).toHaveLength(2);
  expect(finalText(doc).trim()).toBe("The cat quickly sat on the soft mat.");
  // The owner types inside the second insertion: the engine splits it in two.
  const offset = "The cat quickly sat on the so".length;
  session.apply([{ type: "insertText", at: { blockId, offset }, text: "XX" }], { track: true, author: OWNER, origin: "editor" });
  expect(finalText(doc).trim()).toBe("The cat quickly sat on the soXXft mat.");
  const assistant = () => doc.listRevisions().filter((revision) => revision.author !== OWNER);
  return { doc, store, cardId: card.id, assistant };
}

describe("a card with two edits in one paragraph after the owner typed inside the second", () => {
  it("rejecting the first change one by one leaves every piece of the second pending", async () => {
    const { doc, store, cardId, assistant } = await twoEditsInOneParagraph();
    const second = assistant().filter((revision) => revision.text.includes("so") || revision.text.includes("ft"));
    expect(store.startReview(cardId)?.after).toBe("quickly");
    const next = store.resolveCurrent("reject");
    expect(finalText(doc).trim()).toBe("The cat sat on the soXXft mat.");
    expect(assistant().map((revision) => revision.id).sort()).toEqual(second.map((revision) => revision.id).sort());
    expect(next?.after).toBe("soft");
    expect(store.view(cardId)).toMatchObject({ status: "proposed", rejected: 1 });
    // The second change still resolves whole, both halves.
    expect(store.resolveCurrent("reject")).toBeNull();
    expect(assistant()).toEqual([]);
    expect(finalText(doc).trim()).toBe("The cat sat on the XXmat.");
  });

  it("accepting the first change one by one leaves every piece of the second pending", async () => {
    const { doc, store, cardId, assistant } = await twoEditsInOneParagraph();
    const before = assistant().length;
    store.startReview(cardId);
    store.resolveCurrent("accept");
    expect(assistant()).toHaveLength(before - 1);
    expect(finalText(doc).trim()).toBe("The cat quickly sat on the soXXft mat.");
    expect(store.pendingChanges(cardId).map((change) => change.after)).toEqual(["soft"]);
    store.resolveCurrent("accept");
    expect(assistant()).toEqual([]);
  });
});
