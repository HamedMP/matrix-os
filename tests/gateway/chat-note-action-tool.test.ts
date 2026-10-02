import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createNoteActionTool } from "../../packages/gateway/src/chat/note-action-tool.js";

const owner = { type: "personal" as const, ownerId: "owner_notes" };
const args = { app: "notes" as const, title: "Groceries", content: "Milk\nEggs\nBread" };

describe("canonical create-note tool", () => {
  let db: AppDb;
  let instance: InstanceType<typeof KyselyPGlite>;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    const created = createAppDb({ dialect: instance.dialect });
    db = created.db;
    await db.bootstrap();
    await createAppRegistry(db, created.kysely).register({
      slug: "notes",
      name: "Notes",
      tables: { notes: { columns: { title: "text", content: "text", content_json: "jsonb", pinned: "boolean", tags: "text" } } },
    });
    notify = vi.fn();
  });

  afterEach(async () => {
    await db.raw("DROP SCHEMA IF EXISTS notes CASCADE");
    await db.destroy();
  });

  function tool(homeForOwner = vi.fn(async () => "/owner/home")) {
    return createNoteActionTool({ db, homeForOwner, notify });
  }

  function invocation(actionId = "action_groceries", arguments_ = args, signal = new AbortController().signal) {
    return { owner, actionId, arguments: arguments_, signal };
  }

  it("declares one bounded create-only data effect and normalizes strict trimmed input", () => {
    const create = tool();
    expect(create).toMatchObject({ toolId: "matrix_create_note", effect: "data", approval: false, reconciliation: true, cancellation: "before_dispatch" });
    expect(create.normalize({ app: "notes", title: "  Groceries  ", content: "  Milk\nEggs  " })).toEqual({ app: "notes", title: "Groceries", content: "Milk\nEggs" });
    for (const invalid of [
      { app: "todo", title: "x", content: "x" },
      { ...args, extra: true },
      { ...args, title: "   " },
      { ...args, content: "   " },
      { ...args, title: "x".repeat(161) },
      { ...args, content: "x".repeat(16_001) },
    ]) expect(() => create.normalize(invalid)).toThrow();
  });

  it("persists plain text and safe Tiptap paragraphs, returns navigation, and notifies after visibility", async () => {
    const create = tool();
    const result = await create.execute(invocation());
    expect(result).toEqual({ app: "notes", note: { id: expect.any(String), title: "Groceries" }, navigation: { kind: "open_app", app: "notes", path: "apps/notes" } });
    const row = (await db.raw("SELECT * FROM notes.notes")).rows[0]!;
    expect(row).toMatchObject({ id: result.note.id, title: "Groceries", content: "Milk\nEggs\nBread", pinned: false, tags: "" });
    expect(row.content_json).toEqual({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Milk" }] },
      { type: "paragraph", content: [{ type: "text", text: "Eggs" }] },
      { type: "paragraph", content: [{ type: "text", text: "Bread" }] },
    ] });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(owner.ownerId);
  });

  it("is idempotent across retries and concurrent inserts without duplicate notifications", async () => {
    const create = tool();
    const [first, second] = await Promise.all([create.execute(invocation()), create.execute(invocation())]);
    expect(first).toEqual(second);
    expect((await db.raw("SELECT id FROM notes.notes")).rows).toHaveLength(1);
    expect(notify).toHaveBeenCalledOnce();
    await expect(create.execute(invocation())).resolves.toEqual(first);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("rejects a deterministic-id payload mismatch without overwriting it", async () => {
    const create = tool();
    const created = await create.execute(invocation()) as { note: { id: string } };
    await db.raw("UPDATE notes.notes SET title = $1 WHERE id = $2", ["Changed elsewhere", created.note.id]);
    await expect(create.execute(invocation())).rejects.toThrow();
    expect((await db.raw("SELECT title FROM notes.notes WHERE id = $1", [created.note.id])).rows[0]?.title).toBe("Changed elsewhere");
  });

  it("separates owner and operation identities and reconciles only exact rows", async () => {
    const create = tool();
    const first = await create.execute(invocation("action_one")) as { note: { id: string } };
    const second = await create.execute(invocation("action_two")) as { note: { id: string } };
    const third = await create.execute({ ...invocation("action_one"), owner: { type: "personal", ownerId: "owner_other" } }) as { note: { id: string } };
    expect(new Set([first.note.id, second.note.id, third.note.id]).size).toBe(3);
    await expect(create.reconcile!(invocation("action_one"))).resolves.toMatchObject({ confirmed: true, result: { note: { id: first.note.id } } });
    await db.raw("UPDATE notes.notes SET content = $1 WHERE id = $2", ["mismatch", first.note.id]);
    await expect(create.reconcile!(invocation("action_one"))).resolves.toEqual({ confirmed: false });
  });

  it("validates the owner before touching the database and honors pre-dispatch cancellation", async () => {
    const denied = vi.fn(async () => { throw new Error("owner denied"); });
    const raw = vi.spyOn(db, "raw");
    await expect(tool(denied).execute(invocation())).rejects.toThrow("owner denied");
    expect(denied).toHaveBeenCalledWith(owner);
    expect(raw).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    const allowed = vi.fn(async () => "/owner/home");
    await expect(tool(allowed).execute(invocation("action_cancel", args, controller.signal))).rejects.toThrow();
    expect(allowed).toHaveBeenCalledOnce();
    expect((await db.raw("SELECT id FROM notes.notes")).rows).toHaveLength(0);
  });
});
