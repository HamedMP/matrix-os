import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
});
