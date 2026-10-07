import { utf8Size } from "../../home/app-templates/connected-starter/src/edition/utf8-size";
import { expect, it, vi } from "vitest";
import { loadDeviceDownloads } from "../../home/app-templates/connected-starter/src/edition/device-downloads";
import { parseSources } from "../../home/app-templates/connected-starter/src/edition/transport";
const message = {
  id: "m1",
  sourceId: "s1",
  subject: "Edition",
  sender: "Publication",
  publication: "Publication",
  receivedAt: "2026-10-07T00:00:00Z",
  excerpt: "Preview",
  text: "Complete article",
  contentVersion: "v1",
  classification: "newsletter" as const,
  saved: false,
  read: false,
  progress: 0,
  revision: 1,
  readingRevision: 0,
};
it("rolls back a download when the asynchronous trusted host cannot persist it", async () => {
  const host = {
    load: async () => ({ scope: "owner-runtime", raw: null }),
    save: vi.fn(async () => {
      throw new Error("Disk unavailable");
    }),
    clear: async () => {},
  };
  const device = await loadDeviceDownloads(host);
  device.cache.download(message);
  await expect(device.save()).rejects.toThrow();
  expect(device.cache.list()).toEqual([]);
});
it("preserves exact existing consumer sharing from trusted account snapshots", () => {
  expect(
    parseSources({
      sources: [
        {
          id: "s1",
          connectionId: "c1",
          email: "reader@example.test",
          label: "Reading",
          scope: "work",
          state: "paused",
          sharedWith: ["folio", "atlas"],
        },
      ],
    }).sources[0].sharedWith,
  ).toEqual(["folio", "atlas"]);
});

it("counts UTF-8 device limits identically on native and browser runtimes", () => {
  for (const text of [
    "plain",
    "é",
    "日本語",
    "🌷",
    "\ud800",
    "\udc00",
    "a🌷é日本語",
  ])
    expect(utf8Size(text)).toBe(new TextEncoder().encode(text).byteLength);
});
