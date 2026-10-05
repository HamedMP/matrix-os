import { describe, expect, it, vi } from "vitest";
import { createMemoryImportService } from "../../desktop/src/main/memory-import/service";
import { parseMemoryExport } from "../../desktop/src/main/memory-import/export-parser";
import { registerMemoryImportIpc } from "../../desktop/src/main/memory-import/ipc";
const record = {
  externalId: "note:one",
  title: "Example",
  content: "Synthetic source",
  kind: "note" as const,
  collection: "Notes",
};
describe("owner-selected memory imports", () => {
  it("aborts an outstanding native read on shutdown", async () => {
    let signal: AbortSignal | undefined;
    let finish: ((value: unknown) => void) | undefined;
    const service = createMemoryImportService({
      native: async (_provider, _action, _input, operationSignal) => {
        signal = operationSignal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      platform: "darwin",
      chooseFile: async () => null,
      readFile: async () => ({ name: "x", content: "" }),
    });
    const read = service.inventory({ provider: "notes" });
    service.dispose();
    expect(signal?.aborted).toBe(true);
    finish?.({ collections: [], warnings: [] });
    expect(await read).toMatchObject({ status: "error", code: "expired" });
  });
  function setup() {
    const native = vi.fn(async (_provider: string, action: string) =>
      action === "inventory"
        ? { collections: [{ id: "one", label: "Notes" }], warnings: [] }
        : { records: [record], warnings: [] },
    );
    let now = 0;
    return {
      native,
      setNow: (n: number) => (now = n),
      service: createMemoryImportService({
        native,
        now: () => now,
        chooseFile: async () => null,
        readFile: async () => ({ name: "x.md", content: "synthetic" }),
        platform: "darwin",
      }),
    };
  }
  it("does not access anything until the owner requests inventory or preview", async () => {
    const x = setup();
    expect(x.native).not.toHaveBeenCalled();
    expect(await x.service.inventory({ provider: "notes" })).toMatchObject({
      status: "ready",
    });
    expect(x.native).toHaveBeenCalledWith(
      "notes",
      "inventory",
      {},
      expect.any(AbortSignal),
    );
  });
  it("requires inventory and explicit collection selection before preview", async () => {
    const x = setup();
    expect(
      await x.service.preview({
        provider: "notes",
        collectionIds: ["one"],
        limit: 10,
      }),
    ).toMatchObject({ status: "error", code: "selection_required" });
    expect(x.native).not.toHaveBeenCalled();
    await x.service.inventory({ provider: "notes" });
    expect(
      await x.service.preview({
        provider: "notes",
        collectionIds: ["other"],
        limit: 10,
      }),
    ).toMatchObject({ status: "error", code: "selection_required" });
  });
  it("confirms only an exact cached preview, expires it and cannot reuse confirmation", async () => {
    const x = setup();
    await x.service.inventory({ provider: "notes" });
    const p = await x.service.preview({
      provider: "notes",
      collectionIds: ["one"],
      limit: 10,
    });
    expect(p.status).toBe("preview");
    if (p.status !== "preview") throw Error("preview missing");
    expect(
      await x.service.confirm({ selectionId: p.selectionId }),
    ).toMatchObject({ status: "confirmed", records: [record] });
    expect(
      await x.service.confirm({ selectionId: p.selectionId }),
    ).toMatchObject({ status: "error" });
    const p2 = await x.service.preview({
      provider: "notes",
      collectionIds: ["one"],
      limit: 10,
    });
    if (p2.status !== "preview") throw Error("preview missing");
    x.setNow(600001);
    expect(
      await x.service.confirm({ selectionId: p2.selectionId }),
    ).toMatchObject({ status: "error" });
  });
  it("invalidates previews on runtime changes and cancelled picks", async () => {
    const x = setup();
    expect(await x.service.file()).toEqual({ status: "cancelled" });
    await x.service.inventory({ provider: "notes" });
    const p = await x.service.preview({
      provider: "notes",
      collectionIds: ["one"],
      limit: 10,
    });
    x.service.cancelAll();
    if (p.status !== "preview") throw Error("preview missing");
    expect(
      await x.service.confirm({ selectionId: p.selectionId }),
    ).toMatchObject({ status: "error" });
  });
  it("reports denied OS access and unsupported platforms without raw errors", async () => {
    const x = createMemoryImportService({
      native: async () => {
        throw Object.assign(Error("private body"), {
          code: "permission_denied",
        });
      },
      chooseFile: async () => null,
      readFile: async () => ({ name: "x", content: "" }),
      platform: "darwin",
    });
    expect(await x.inventory({ provider: "mail" })).toEqual({
      status: "error",
      code: "permission_denied",
      message:
        "Allow Matrix OS to access this app in System Settings → Privacy & Security → Automation, then try again.",
    });
    const y = createMemoryImportService({
      native: vi.fn(),
      chooseFile: async () => null,
      readFile: async () => ({ name: "x", content: "" }),
      platform: "linux",
    });
    expect(await y.inventory({ provider: "calendar" })).toMatchObject({
      status: "error",
      code: "unsupported",
    });
  });
  it("binds cached previews independently to owner and runtime", async () => {
    let actor: string | null = "owner-a/runtime-a";
    const x = createMemoryImportService({
      native: async (_provider, action) =>
        action === "inventory"
          ? { collections: [{ id: "one", label: "Notes" }], warnings: [] }
          : { records: [record], warnings: [] },
      identity: () => actor,
      chooseFile: async () => null,
      readFile: async () => ({ name: "x", content: "" }),
      platform: "darwin",
    });
    await x.inventory({ provider: "notes" });
    const p = await x.preview({
      provider: "notes",
      collectionIds: ["one"],
      limit: 10,
    });
    actor = "owner-b/runtime-b";
    if (p.status !== "preview") throw Error("preview missing");
    expect(await x.confirm({ selectionId: p.selectionId })).toMatchObject({
      status: "error",
      code: "expired",
    });
    expect(
      await x.preview({ provider: "notes", collectionIds: ["one"], limit: 10 }),
    ).toMatchObject({ status: "error", code: "selection_required" });
    actor = null;
    expect(await x.inventory({ provider: "notes" })).toMatchObject({
      status: "error",
    });
    x.dispose();
  });
  it("confirms only chosen records and rejects invented IDs", async () => {
    const x = setup();
    await x.service.inventory({ provider: "notes" });
    const p = await x.service.preview({
      provider: "notes",
      collectionIds: ["one"],
      limit: 10,
    });
    if (p.status !== "preview") throw Error("preview missing");
    expect(
      await x.service.confirm({
        selectionId: p.selectionId,
        externalIds: ["invented"],
      }),
    ).toMatchObject({ status: "error", code: "selection_required" });
    expect(
      await x.service.confirm({
        selectionId: p.selectionId,
        externalIds: [record.externalId],
      }),
    ).toMatchObject({ status: "confirmed", records: [record] });
    x.service.dispose();
  });
  it("rejects malformed native responses rather than partially uploading them", async () => {
    const x = setup();
    x.native.mockResolvedValueOnce({
      collections: [{ id: "one", label: "Notes" }],
      warnings: [],
    });
    await x.service.inventory({ provider: "notes" });
    x.native.mockResolvedValueOnce({
      records: [{ ...record, secret: "x" }],
      warnings: [],
    } as never);
    expect(
      await x.service.preview({
        provider: "notes",
        collectionIds: ["one"],
        limit: 10,
      }),
    ).toMatchObject({ status: "error" });
  });
});
describe("export import", () => {
  it("keeps a file identity stable across content updates", () => {
    expect(
      parseMemoryExport("note.md", "old", "owner-picked-path").records[0]
        .externalId,
    ).toBe(
      parseMemoryExport("note.md", "new", "owner-picked-path").records[0]
        .externalId,
    );
  });
  it("supports bounded normalized JSON and plain text", () => {
    expect(
      parseMemoryExport("sources.json", JSON.stringify({ records: [record] }))
        .records,
    ).toEqual([record]);
    expect(
      parseMemoryExport("note.md", "# Example\nSource").records[0],
    ).toMatchObject({ kind: "document", content: "# Example\nSource" });
  });
  it("keeps recurring exceptions distinct and namespaces calendar exports by their source", () => {
    const event = (recurrence = "", title = "Review") => `BEGIN:VEVENT\nUID:shared-uid\nSUMMARY:${title}\nDTSTART:20261005T100000Z\n${recurrence}END:VEVENT\n`;
    const content = `BEGIN:VCALENDAR\n${event()}${event("RECURRENCE-ID:20261012T100000Z\n", "Rescheduled")}END:VCALENDAR`;
    const first = parseMemoryExport("calendar.ics", content, "account-a/file-one");
    expect(first.records).toHaveLength(2);
    expect(first.records[0].externalId).not.toBe(first.records[1].externalId);
    expect(first.records[1].metadata?.recurrenceId).toBe("20261012T100000Z");
    expect(parseMemoryExport("calendar.ics", content, "account-b/file-one").records[0].externalId).not.toBe(first.records[0].externalId);
    expect(parseMemoryExport("calendar.ics", content, "account-a/file-two").records[0].externalId).not.toBe(first.records[0].externalId);
    expect(parseMemoryExport("renamed.ics", content.replace("Review", "Updated"), "account-a/file-one").records[0].externalId).toBe(first.records[0].externalId);
  });
  it("preserves calendar recurrence/timezone without fabricating UTC dates", () => {
    const p = parseMemoryExport(
      "events.ics",
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:evt\nSUMMARY:Review\nDTSTART;TZID=Europe/Stockholm:20261005T100000\nRRULE:FREQ=WEEKLY\nDESCRIPTION:One\\nTwo\nEND:VEVENT\nEND:VCALENDAR",
    );
    expect(p.records[0]).toMatchObject({
      kind: "calendar",
      externalId: expect.stringMatching(/^calendar:export:[a-f0-9]{64}:[a-f0-9]{64}$/),
      metadata: {
        start: "20261005T100000",
        timeZone: "Europe/Stockholm",
        recurrence: "FREQ=WEEKLY",
      },
    });
    expect(p.records[0].occurredAt).toBeUndefined();
  });
  it("rejects unsupported multipart email and malformed calendar data", () => {
    expect(() =>
      parseMemoryExport(
        "mail.eml",
        "Content-Type: multipart/mixed; boundary=x\n\nprivate",
      ),
    ).toThrow();
    expect(() =>
      parseMemoryExport("events.ics", "BEGIN:VCALENDAR\nEND:VCALENDAR"),
    ).toThrow();
  });
  it("reads a plain email and records attachment limitation", () => {
    expect(
      parseMemoryExport(
        "mail.eml",
        "Message-ID: <one>\nSubject: Synthetic\nContent-Type: text/plain\n\nHello",
      ).records[0],
    ).toMatchObject({ kind: "email", title: "Synthetic", content: "Hello" });
  });
});
describe("memory import trusted IPC", () => {
  it("rejects untrusted frames and invalid selections", async () => {
    const handlers = new Map<
      string,
      (e: unknown, p: unknown) => Promise<unknown>
    >();
    const service = createMemoryImportService({
      native: vi.fn(),
      platform: "linux",
      chooseFile: async () => null,
      readFile: async () => ({ name: "x", content: "" }),
    });
    registerMemoryImportIpc(
      { handle: (channel, fn) => handlers.set(channel, fn) },
      service,
      (e) => e === "trusted",
    );
    await expect(
      handlers.get("memory:import-inventory")!("frame", { provider: "notes" }),
    ).rejects.toThrow("invalid request");
    await expect(
      handlers.get("memory:import-preview")!("trusted", {
        provider: "notes",
        collectionIds: [],
        limit: 100000,
      }),
    ).rejects.toThrow("invalid request");
  });
});
