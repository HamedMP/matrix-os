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
