/**
 * Meaning search sends only the provenances the owner allowed: by default the project's git documents; a chat, note,
 * file or calendar document is never read for embedding, never sent, and never counted as pending, unless listed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectEmbedSources } from "../../packages/gateway/src/brain/search/index-sql.js";
import { createBrainSearchIndex } from "../../packages/gateway/src/brain/search/indexer.js";
import { brainCurrentEmbedProvenances, brainEmbedProvenances } from "../../packages/gateway/src/brain/search/types.js";
import {
  SCOPE, createSearchHarness, createSeeder, fakeProvider, fakeVectorStore, type SearchHarness,
} from "./helpers/brain-search-fakes.js";
import { brainDocumentId } from "./helpers/brain-store-helpers.js";

const signal = () => AbortSignal.timeout(10_000);
const PRIVATE = { chat: "private chat transcript", note: "private note text", event: "calendar description" };

describe("brain search embedding allow-list", { timeout: 60_000 }, () => {
  let h: SearchHarness;
  let seeder: Awaited<ReturnType<typeof createSeeder>>;
  beforeEach(async () => {
    h = await createSearchHarness();
    seeder = await createSeeder(h);
    await seeder.sync([
      { seed: "pr", title: "PR", body: "git pull request text", provenance: "git_pr" },
      { seed: "chat", title: "Chat", body: PRIVATE.chat, provenance: "matrix_chat" },
      { seed: "note", title: "Note", body: PRIVATE.note, provenance: "matrix_note" },
      { seed: "event", title: "Event", body: PRIVATE.event, provenance: "calendar_event" },
    ]);
  });
  afterEach(async () => { await h.destroy(); });

  async function refreshWith(provenances: readonly string[] | undefined) {
    const provider = fakeProvider({ provenances });
    const vectors = await fakeVectorStore(h);
    const index = createBrainSearchIndex({ db: h.db, meaning: { provider, vectors }, now: h.now });
    const result = await index.refresh(SCOPE, {}, signal());
    return { result, sent: provider.calls.flat().join("\n"), vectors, freshness: await index.freshness(SCOPE) };
  }

  it("sends only git documents by default and counts the others as caught up, not pending", async () => {
    const { result, sent, vectors, freshness } = await refreshWith(undefined);
    expect(result).toMatchObject({ caughtUp: true });
    expect(sent).toContain("git pull request text");
    for (const text of Object.values(PRIVATE)) expect(sent).not.toContain(text);
    expect(vectors.replaced).toEqual([`${brainDocumentId("pr")}:1`]);
    expect(freshness).toEqual({ caughtUp: true, pendingDocuments: 0, pendingCapped: false });
  });

  it("sends a listed provenance and still never an unlisted one", async () => {
    const { sent, freshness } = await refreshWith(["git_pr", "matrix_note"]);
    expect(sent).toContain(PRIVATE.note);
    expect(sent).not.toContain(PRIVATE.chat);
    expect(sent).not.toContain(PRIVATE.event);
    expect(freshness.caughtUp).toBe(true);
  });

  it("never reads an unlisted document for embedding, even when asked for it by id", async () => {
    const ids = ["pr", "chat", "note", "event"].map(brainDocumentId);
    const target = { marker: "fake", provenances: brainEmbedProvenances(fakeProvider({ provenances: undefined })) };
    const rows = await selectEmbedSources(h.db, SCOPE, target, ids);
    expect(rows.map((row) => row.document_id)).toEqual([brainDocumentId("pr")]);
  });

  it("reads the owner's list again at each refresh, so a narrowed list stops sending without a restart", async () => {
    let current: readonly string[] = ["git_pr", "matrix_note"];
    const provider = fakeProvider({ provenances: ["git_pr", "matrix_note"], currentProvenances: async () => current });
    const vectors = await fakeVectorStore(h);
    const index = createBrainSearchIndex({ db: h.db, meaning: { provider, vectors }, now: h.now });
    await index.refresh(SCOPE, {}, signal());
    expect(provider.calls.flat().join("\n")).toContain(PRIVATE.note);
    // The note changes after the owner took notes off the list: its new text is never sent, and it is not pending.
    current = ["git_pr"];
    await seeder.sync([{ seed: "note", title: "Note", body: "changed private note", provenance: "matrix_note" }]);
    provider.calls.length = 0;
    expect(await index.refresh(SCOPE, {}, signal())).toMatchObject({ caughtUp: true });
    expect(provider.calls.flat().join("\n")).not.toContain("changed private note");
    expect(await index.freshness(SCOPE)).toMatchObject({ caughtUp: true });
    // Settings that read as nothing send nothing at all.
    current = [];
    await seeder.sync([{ seed: "pr", title: "PR", body: "git pull request text, revised", provenance: "git_pr" }]);
    provider.calls.length = 0;
    expect(await index.refresh(SCOPE, {}, signal())).toMatchObject({ caughtUp: true });
    expect(provider.calls).toEqual([]);
    expect(brainCurrentEmbedProvenances(["Not Valid"])).toEqual([]);
    expect(brainCurrentEmbedProvenances(["git_pr", "git_pr"])).toEqual(["git_pr"]);
  });

  it("embeds nothing for a scope whose owner does not hold the provider's key", async () => {
    const provider = fakeProvider({ provenances: undefined });
    const vectors = await fakeVectorStore(h);
    const index = createBrainSearchIndex({ db: h.db, meaning: { provider, vectors }, now: h.now, ownerIds: ["someone_else"] });
    const result = await index.refresh(SCOPE, {}, signal());
    expect(result).toMatchObject({ caughtUp: true });
    expect(result).not.toHaveProperty("embedding");
    expect(provider.calls).toEqual([]);
    expect(await index.freshness(SCOPE)).toMatchObject({ caughtUp: true });
  });

  it("falls back to the git default for a missing, empty, malformed or oversized list", () => {
    const git = ["git_pr", "git_commit", "git_spec"];
    for (const provenances of [undefined, [], ["Not Valid"], Array.from({ length: 33 }, (_, i) => `p${i}`)]) {
      expect(brainEmbedProvenances(fakeProvider({ provenances }))).toEqual(git);
    }
    expect(brainEmbedProvenances(fakeProvider({ provenances: ["matrix_chat", "matrix_chat"] }))).toEqual(["matrix_chat"]);
  });
});
