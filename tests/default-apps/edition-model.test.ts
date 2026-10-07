import { describe, expect, it } from "vitest";
import {
  filterEditions,
  publicationGroups,
} from "../../home/app-templates/connected-starter/src/edition/model";
import { EditionDownloads } from "../../home/app-templates/connected-starter/src/edition/offline";
const sources = [
  { id: "work", scope: "work" as const },
  { id: "home", scope: "personal" as const },
];
const row = (id: string, sourceId: string, publication: string) => ({
  id,
  sourceId,
  publication,
  subject: id,
  sender: publication,
  receivedAt: "2026-10-07",
  excerpt: "news",
  text: "Full retained text",
  contentVersion: "1",
  classification: "newsletter" as const,
  saved: false,
  read: false,
  progress: 0,
  revision: 1,
  readingRevision: 1,
});
describe("Edition derivations and scoped downloads", () => {
  it("filters by exact source ownership and leaves uncertain mail in Review", () => {
    const all = [
      row("one", "work", "A"),
      row("two", "home", "A"),
      { ...row("three", "home", "B"), classification: "review" as const },
    ];
    expect(
      filterEditions(all, sources, {
        view: "latest",
        scope: "work",
        query: "",
      }).map((r) => r.id),
    ).toEqual(["one"]);
    expect(
      filterEditions(all, sources, {
        view: "review",
        scope: "all",
        query: "",
      }).map((r) => r.id),
    ).toEqual(["three"]);
    expect(publicationGroups(all.slice(0, 2))[0].count).toBe(2);
  });
  it("bounds downloads, rejects incomplete content and isolates authenticated scopes", () => {
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
      removeItem: (k: string) => {
        storage.delete(k);
      },
    };
    const cache = new EditionDownloads(adapter, "owner-runtime-grants");
    cache.download(row("one", "home", "A"));
    expect(cache.read("one")?.text).toBe("Full retained text");
    expect(
      new EditionDownloads(adapter, "another-owner").read("one"),
    ).toBeNull();
    expect(() =>
      cache.download({ ...row("two", "home", "A"), text: undefined }),
    ).toThrow();
    for (let i = 0; i < 49; i++) cache.download(row("id" + i, "home", "A"));
    expect(() => cache.download(row("over-cap", "home", "A"))).toThrow();
    expect(cache.list().length).toBe(50);
    cache.clear();
    expect(cache.list()).toEqual([]);
  });
  it("stores only bounded metadata edits and never queues source cleanup", () => {
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
      removeItem: (k: string) => {
        storage.delete(k);
      },
    };
    const cache = new EditionDownloads(adapter, "scope");
    cache.queue({ id: "one", baseRevision: 1, saved: true });
    expect(cache.pending()).toEqual([
      { id: "one", baseRevision: 1, saved: true },
    ]);
    expect(() =>
      cache.queue({ id: "one", baseRevision: 1, cleanup: true } as any),
    ).toThrow();
  });
  it("preserves newer queued changes while advancing the confirmed CAS revision", () => {
    const storage = new Map<string, string>();
    const cache = new EditionDownloads(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
        removeItem: (key) => {
          storage.delete(key);
        },
      },
      "scope",
    );
    const message = row("one", "home", "A");
    cache.download(message);
    const sent = { id: "one", baseRevision: 1, saved: true };
    cache.queue(sent);
    cache.queue({ id: "one", baseRevision: 1, read: true });
    cache.acknowledge(sent, { ...message, saved: true, readingRevision: 2 });
    expect(cache.pending()).toEqual([
      { id: "one", baseRevision: 2, saved: true, read: true },
    ]);
    expect(cache.read("one")).toMatchObject({
      saved: true,
      read: true,
      readingRevision: 2,
    });
  });
});
