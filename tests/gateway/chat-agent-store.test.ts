import { mkdir, mkdtemp, open, opendir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { constants, type Dir } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";

const owner = { type: "personal" as const, ownerId: "owner_agent" };
const other = { type: "personal" as const, ownerId: "owner_other" };
const input = {
  clientRequestId: "req_create_bot",
  name: "Meeting helper",
  description: "Prepare concise meeting briefs",
  instructions: "Identify decisions, open questions, and the next action.",
  selection: { instanceId: "hermes_default", model: "openai:gpt-5.6-sol" },
};

describe("owner-controlled Chat Agent definitions", () => {
  let home: string;
  let db: Kysely<ChatDatabase>;
  let store: ChatAgentStore;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-chat-agents-"));
    db = new Kysely({ dialect: (await KyselyPGlite.create()).dialect });
    store = new ChatAgentStore({ homePath: home, db });
    await store.bootstrap();
  });
  afterEach(async () => {
    await store.close();
    await db.destroy();
    await rm(home, { recursive: true, force: true });
  });

  it("persists an inspectable Markdown role and replays creation without making a second Bot", async () => {
    const created = await store.create(owner, input);
    expect(await store.create(owner, input)).toEqual(created);
    const restarted = new ChatAgentStore({ homePath: home, db });
    expect(await restarted.get(owner, created.id)).toEqual(created);
    expect(await restarted.list(owner)).toEqual([created]);
    const root = join(home, "agents/custom/chat-bots");
    const directory = (await readdir(root))[0]!;
    const files = await readdir(join(root, directory));
    expect(files).toEqual([`${created.id}.md`]);
    expect(await readFile(join(root, directory, files[0]!), "utf8")).toContain(input.instructions);
    await restarted.close();
  });

  it("does not expose or mutate another owner's Agent", async () => {
    const created = await store.create(owner, input);
    expect(await store.list(other)).toEqual([]);
    expect(await store.get(other, created.id)).toBeNull();
    await expect(store.update(other, created.id, { baseRevision: created.revision, archived: true }))
      .rejects.toMatchObject({ code: "agent_not_found" });
    expect((await store.get(owner, created.id))?.archived).toBe(false);
  });

  it("rejects changed idempotency payloads and stale revisions while preserving the accepted definition", async () => {
    const created = await store.create(owner, input);
    await expect(store.create(owner, { ...input, instructions: "Changed silently" }))
      .rejects.toMatchObject({ code: "agent_conflict" });
    const edited = await store.update(owner, created.id, {
      baseRevision: created.revision, name: "Partner meeting helper",
    });
    expect(edited.name).toBe("Partner meeting helper");
    expect(edited.instructions).toBe(input.instructions);
    await expect(store.update(owner, created.id, { baseRevision: created.revision, archived: true }))
      .rejects.toMatchObject({ code: "agent_conflict" });
    expect((await store.get(owner, created.id))?.archived).toBe(false);
  });

  it("retains archived roles for historical attribution but excludes them from normal lists", async () => {
    const created = await store.create(owner, input);
    const archived = await store.update(owner, created.id, { baseRevision: created.revision, archived: true });
    expect(archived.archived).toBe(true);
    expect(await store.list(owner)).toEqual([]);
    expect(await store.get(owner, created.id)).toEqual(archived);
    const restored = await store.update(owner, created.id, { baseRevision: archived.revision, archived: false });
    expect(await store.list(owner)).toEqual([restored]);
  });

  it("round-trips a recipe and clears it with an explicit null update", async () => {
    const recipe = {
      skills: ["matrix-personal-daily-brief", "matrix-integrations"] as const,
      integrations: [{ service: "gmail" }, { service: "google_calendar", accountLabel: "Work" }],
      output: "English daily brief with source links",
    };
    const created = await store.create(owner, { ...input, clientRequestId: "req_recipe", recipe });
    expect((await store.get(owner, created.id))?.recipe).toEqual(recipe);
    const cleared = await store.update(owner, created.id, { baseRevision: created.revision, recipe: null });
    expect(cleared.recipe).toBeUndefined();
    const restarted = new ChatAgentStore({ homePath: home, db });
    expect((await restarted.get(owner, created.id))?.recipe).toBeUndefined();
    await restarted.close();
  });

  it("rejects symlinked definitions and never follows them to another owner's contents", async () => {
    const created = await store.create(owner, input);
    const root = join(home, "agents/custom/chat-bots");
    const directory = (await readdir(root))[0]!;
    const path = join(root, directory, `${created.id}.md`);
    const privatePath = join(home, "private.txt");
    await writeFile(privatePath, "private contents");
    await rm(path);
    await symlink(privatePath, path);
    await expect(store.get(owner, created.id)).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(await readFile(privatePath, "utf8")).toBe("private contents");
  });
  it.each(["get", "list", "create", "update"] as const)("rejects FIFO definitions during %s without waiting for a writer", async (operation) => {
    const created = await store.create(owner, input);
    const root = join(home, "agents/custom/chat-bots");
    const path = join(root, (await readdir(root))[0]!, `${created.id}.md`);
    await rm(path);
    execFileSync("mkfifo", [path], { timeout: 1_000 });
    const action = operation === "get" ? store.get(owner, created.id)
      : operation === "list" ? store.list(owner)
      : operation === "create" ? store.create(owner, input)
      : store.update(owner, created.id, { baseRevision: created.revision, name: "Changed" });
    const read = action.then(() => "accepted", (error: unknown) => error);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([read, new Promise((resolve) => { timeout = setTimeout(() => resolve("blocked"), 200); })]);
      expect(result).toMatchObject({ code: "agent_unavailable" });
    } finally {
      clearTimeout(timeout);
      // Release a regressed blocking reader so this test never leaves a worker hung.
      const writer = await open(path, constants.O_RDWR | constants.O_NONBLOCK);
      await read;
      await writer.close();
    }
  });

  it("rejects copied metadata IDs before mutating another Agent", async () => {
    const first = await store.create(owner, input);
    const second = await store.create(owner, { ...input, clientRequestId: "req_second", name: "Second helper" });
    const root = join(home, "agents/custom/chat-bots");
    const directory = join(root, (await readdir(root))[0]!);
    const path = join(directory, `${first.id}.md`);
    await writeFile(path, (await readFile(path, "utf8")).replace(first.id, second.id));
    await expect(store.update(owner, first.id, { baseRevision: first.revision, name: "Wrong target" }))
      .rejects.toMatchObject({ code: "agent_unavailable" });
    expect(await store.get(owner, second.id)).toEqual(second);
    await expect(store.create(owner, input)).rejects.toMatchObject({ code: "agent_unavailable" });
  });

  it("eventually cleans stale temporary files beyond the first bounded file batch", async () => {
    await store.create(owner, input);
    const root = join(home, "agents/custom/chat-bots");
    const directory = join(root, (await readdir(root))[0]!);
    for (let i = 0; i < 260; i++) await writeFile(join(directory, `.${String(i).padStart(36, "0")}.tmp`), "recent");
    const names = [];
    for await (const entry of await opendir(directory)) names.push(entry.name);
    const path = join(directory, names.filter((name) => name.endsWith(".tmp")).at(-1)!);
    await utimes(path, 0, 0);
    const cleanup = store as unknown as { sweepTemporaryFiles(): Promise<void> };
    for (let i = 0; i < 4; i++) await cleanup.sweepTemporaryFiles();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(directory, names.find((name) => name.endsWith(".md"))!), "utf8")).toContain(input.instructions);
  });

  it("eventually visits owner directories beyond the first bounded owner batch", async () => {
    const root = join(home, "agents/custom/chat-bots");
    for (let i = 0; i < 270; i++) await mkdir(join(root, String(i).padStart(64, "0")), { recursive: true });
    const names = [];
    for await (const entry of await opendir(root)) names.push(entry.name);
    const path = join(root, names.at(-1)!, ".00000000-0000-0000-0000-000000000000.tmp");
    await writeFile(path, "stale");
    await utimes(path, 0, 0);
    const cleanup = store as unknown as { sweepTemporaryFiles(): Promise<void> };
    for (let i = 0; i < 4; i++) await cleanup.sweepTemporaryFiles();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes unfinished cleanup cursors on shutdown", async () => {
    await store.create(owner, input);
    const root = join(home, "agents/custom/chat-bots");
    const directory = join(root, (await readdir(root))[0]!);
    for (let i = 0; i < 260; i++) await writeFile(join(directory, `keep-${i}`), "recent");
    const cleanup = store as unknown as {
      sweepTemporaryFiles(): Promise<void>;
      sweepRoot: Dir | null;
      sweepOwner: { directory: Dir } | null;
    };
    await cleanup.sweepTemporaryFiles();
    const rootCursor = cleanup.sweepRoot!;
    const ownerCursor = cleanup.sweepOwner!.directory;
    expect(rootCursor).toBeTruthy();
    expect(ownerCursor).toBeTruthy();
    await store.close();
    await expect(rootCursor.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" });
    await expect(ownerCursor.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" });
  });

  it("cleans only stale regular temporary files and preserves symlink targets", async () => {
    const created = await store.create(owner, input);
    const root = join(home, "agents/custom/chat-bots");
    const directory = join(root, (await readdir(root))[0]!);
    const stale = join(directory, ".00000000-0000-0000-0000-000000000000.tmp");
    const recent = join(directory, ".00000000-0000-0000-0000-000000000001.tmp");
    const linked = join(directory, ".00000000-0000-0000-0000-000000000002.tmp");
    const target = join(home, "private.txt");
    await writeFile(stale, "stale");
    await writeFile(recent, "recent");
    await writeFile(target, "preserve");
    await utimes(stale, 0, 0);
    await utimes(target, 0, 0);
    await symlink(target, linked);
    await (store as unknown as { sweepTemporaryFiles(): Promise<void> }).sweepTemporaryFiles();
    await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(recent, "utf8")).toBe("recent");
    expect(await readFile(linked, "utf8")).toBe("preserve");
    expect(await store.get(owner, created.id)).toEqual(created);
  });

});
