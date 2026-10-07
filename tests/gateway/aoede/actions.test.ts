import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KyselyPGlite } from "kysely-pglite";
import { createAppDb } from "../../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../../packages/gateway/src/app-db-registry.js";
import { registerNativeAppStorage } from "../../../packages/gateway/src/native-app-storage.js";
import { AoedeActions, classify, type UiRequest } from "../../../packages/gateway/src/aoede/actions.js";

let home: string;
let storage: ReturnType<typeof createAppDb>;
let actions: AoedeActions;
let ui: (request: UiRequest) => Promise<any>;
let changed: string[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aoede-actions-"));
  const instance = await KyselyPGlite.create();
  storage = createAppDb({ dialect: instance.dialect });
  await storage.db.bootstrap();
  const registry = createAppRegistry(storage.db, storage.kysely);
  await registerNativeAppStorage(registry);
  changed = [];
  ui = async (r) => ({ sessionId: r.sessionId, correlationId: r.correlationId, phase: r.phase, status: "ok", slug: "notes" });
  actions = new AoedeActions({ principal: { userId: "owner", source: "jwt" }, ownerId: "owner", homePath: home,
    registry, database: storage.kysely, uiAction: (r) => ui(r), notifyDataChange: async (id) => { changed.push(id); } });
});
afterEach(async () => { await storage?.db.destroy(); await rm(home, { recursive: true, force: true }); });

it("leaves ambiguous or compound instructions to Chat", () => {
  for (const text of ["open it", "open notes and delete files", "forget that", "append milk", "remember " , "open notes\nclose notes",
    "Can you open it?", "Could you open notes then delete files?", "Please open notes or calendar.", "Can you list my apps and open notes?"])
    expect(classify(text)).toBeNull();
  expect(classify('append "milk" to note "Groceries"')).toEqual({ type: "append_note", title: "Groceries", text: "milk" });
});
it("recognizes bounded conversational app commands without including politeness or punctuation in the target", () => {
  for (const text of ["Can you open notes", "Could you please open my notes app?", "Please open notes.", "Would you open notes, please?"])
    expect(classify(text)).toEqual({ type: "open_app", target: "notes" });
  expect(classify("Can you close my calendar app? please")).toBeNull();
  expect(classify("Can you close my calendar app? ")).toEqual({ type: "close_app", target: "calendar" });
  for (const text of ["Can you list my apps", "Please list apps.", "Could you please list my apps?", "List my apps, please."])
    expect(classify(text)).toEqual({ type: "list_apps" });
});
it("checks installed slug and actual correlated effect, never delivery alone", async () => {
  const action = classify("open my notes app")!;
  ui = async (r) => ({ ...r, status: "ok", slug: "uninstalled" });
  expect((await actions.execute(action, "session")).status).toBe("not_found");
  ui = async (r) => ({ ...r, status: r.phase === "resolve" ? "ok" : "failed", slug: "notes" });
  expect((await actions.execute(action, "session")).status).toBe("failed");
  ui = async (r) => ({ ...r, sessionId: "other", status: "ok", slug: "notes" });
  expect((await actions.execute(action, "session")).status).toBe("failed");
});
it("persists markdown and rich formatting through append and unique edit", async () => {
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "eggs", marks: [{ type: "bold" }] }] }] };
  await storage.kysely.insertInto("notes.notes").values({ title: "Groceries", content: "**eggs**", content_json: JSON.stringify(doc) }).execute();
  expect((await actions.execute(classify('append "milk" to note "Groceries"')!, "s")).status).toBe("ok");
  expect((await actions.execute(classify('edit note "Groceries" replace "eggs" with "bread"')!, "s")).status).toBe("ok");
  const row = await storage.kysely.selectFrom("notes.notes").selectAll().executeTakeFirstOrThrow();
  expect(row.content).toBe("**bread**\n\nmilk");
  expect(row.content_json.content[0].content[0]).toEqual({ type: "text", text: "bread", marks: [{ type: "bold" }] });
  expect(row.content_json.content[1].content[0].text).toBe("milk");
  expect(changed).toEqual(["notes", "notes"]);
});
it("does not update missing or duplicate note targets", async () => {
  const action = classify('append "milk" to note "Groceries"')!;
  expect((await actions.execute(action, "s")).status).toBe("not_found");
  for (let i = 0; i < 2; i++) await storage.kysely.insertInto("notes.notes").values({ title: "Groceries", content: "eggs" }).execute();
  expect((await actions.execute(action, "s")).status).toBe("ambiguous");
  expect((await storage.kysely.selectFrom("notes.notes").select("content").execute()).map(r => r.content)).toEqual(["eggs", "eggs"]);
});
it("preserves legacy facts across concurrent remember and exact forget", async () => {
  await mkdir(join(home, "system"));
  await writeFile(join(home, "system/vocal-profile.json"), JSON.stringify({ facts: ["my name is Arian"], updatedAt: "old" }));
  await Promise.all(["I like tea", "I like cats"].map(text => actions.execute({ type: "remember", fact: text }, "s")));
  const list = await actions.execute({ type: "list_facts" }, "s");
  expect(list.facts).toEqual(["my name is Arian", "I like tea", "I like cats"]);
  expect((await actions.execute({ type: "forget", fact: "I like tea" }, "s")).status).toBe("ok");
  expect((await actions.execute({ type: "list_facts" }, "s")).facts).toEqual(["my name is Arian", "I like cats"]);
});
it("does not overwrite a corrupt existing profile", async () => {
  await mkdir(join(home, "system"));
  const path = join(home, "system/vocal-profile.json");
  await writeFile(path, "broken legacy data");
  expect((await actions.execute({ type: "remember", fact: "I like tea" }, "s")).status).toBe("failed");
  expect(await readFile(path, "utf8")).toBe("broken legacy data");
});
it("creates a renderable note and lists installed apps; confirms open and close effects", async () => {
  const created = await actions.execute(classify('create note "Ideas" with "Try tea"')!, "s");
  expect(created.status).toBe("ok");
  const row = await storage.kysely.selectFrom("notes.notes").selectAll().where("id", "=", created.noteId!).executeTakeFirstOrThrow();
  expect(row.content).toBe("Try tea");
  expect(row.content_json).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Try tea" }] }] });
  expect((await actions.execute({ type: "list_apps" }, "s")).apps).toEqual([{ slug: "notes", name: "Notes" }]);
  for (const verb of ["open", "close"]) expect((await actions.execute(classify(`${verb} notes`)!, "s")).message).toBe(`Notes ${verb === "open" ? "opened" : "closed"}.`);
});
it("rejects another principal without changing owner data", async () => {
  const denied = new AoedeActions({ principal: { userId: "intruder", source: "jwt" }, ownerId: "owner", homePath: home,
    registry: createAppRegistry(storage.db, storage.kysely), database: storage.kysely,
    uiAction: async () => { throw new Error("must not reach UI"); }, notifyDataChange: () => {} });
  expect((await denied.execute({ type: "remember", fact: "I like tea" }, "s")).status).toBe("failed");
  expect((await actions.execute({ type: "list_facts" }, "s")).facts).toEqual([]);
});
it("hydrates legacy plain text on append and rejects uncertain edits", async () => {
  await storage.kysely.insertInto("notes.notes").values({ title: "Groceries", content: "eggs", content_json: { type: "doc", content: [{ type: "paragraph" }] } }).execute();
  for (const text of ["milk", "bread"]) expect((await actions.execute({ type: "append_note", title: "Groceries", text }, "s")).status).toBe("ok");
  const original = await storage.kysely.selectFrom("notes.notes").selectAll().executeTakeFirstOrThrow();
  expect(original.content.split("\n\n").sort()).toEqual(["bread", "eggs", "milk"]);
  expect(original.content_json.content.map((n: any) => n.content[0].text).sort()).toEqual(["bread", "eggs", "milk"]);
  expect((await actions.execute({ type: "edit_note", title: "Groceries", before: "missing", after: "tea" }, "s")).status).toBe("ambiguous");
  const unchanged = await storage.kysely.selectFrom("notes.notes").selectAll().executeTakeFirstOrThrow();
  expect(unchanged).toEqual(original);
});
it("caps remembered facts, deduplicates, and rejects oversized direct requests", async () => {
  for (let i = 0; i < 51; i++) await actions.execute({ type: "remember", fact: `I like item ${i}` }, "s");
  await actions.execute({ type: "remember", fact: "I LIKE ITEM 50" }, "s");
  const facts = (await actions.execute({ type: "list_facts" }, "s")).facts!;
  expect(facts).toHaveLength(50);
  expect(facts[0]).toBe("I like item 1");
  expect(facts[49]).toBe("I like item 50");
  expect((await actions.execute({ type: "remember", fact: "x".repeat(513) }, "s")).status).toBe("failed");
  expect((await actions.execute({ type: "list_facts" }, "s")).facts).toEqual(facts);
});
it("times out missing UI acknowledgement and ignores a later successful response", async () => {
  let resolve!: (result: any) => void;
  let request!: UiRequest;
  ui = r => { request = r; return new Promise(done => { resolve = done; }); };
  vi.useFakeTimers();
  try {
    const pending = actions.execute({ type: "open_app", target: "Notes" }, "s");
    await vi.advanceTimersByTimeAsync(2501);
    const failed = await pending;
    expect(failed.status).toBe("failed");
    resolve({ ...request, status: "ok", slug: "notes" });
    await Promise.resolve();
    expect(failed.message).not.toContain("opened");
  } finally { vi.useRealTimers(); }
});
