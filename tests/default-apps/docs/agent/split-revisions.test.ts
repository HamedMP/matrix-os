import { describe, expect, it } from "vitest";
import { AssistantStore } from "../../../../home/apps/docs/src/ui/agent/assistant-store";
import { OWNER, envelope, finalText, scripted, sessionWith } from "./helpers";

async function proposedQuickly() {
  const session = await sessionWith(["The cat sat."]);
  const doc = session.document!;
  const blockId = doc.getView().body.blocks[0]!.id;
  const model = scripted(envelope([{ op: "replaceText", blockId, find: "cat sat", replace: "cat quickly sat" }], "Adds an adverb."));
  const store = new AssistantStore({ session, generate: model.generate, getSelection: () => null, log: () => undefined });
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
    const card = store.getState().cards.find((entry) => entry.id === cardId);
    expect(card).toMatchObject({ status: "rejected" });
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
