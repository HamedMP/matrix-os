import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryExport } from "../../desktop/src/main/memory-import/native";
import { MEMORY_IMPORT_SCRIPT } from "../../desktop/src/main/memory-import/native-script";
let folder: string | undefined;
afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});
describe("bounded memory export reads", () => {
  it("reads only a regular owner-picked file and rejects symlinks", async () => {
    folder = await mkdtemp(join(tmpdir(), "matrix-memory-export-"));
    const file = join(folder, "synthetic.md");
    await writeFile(file, "# Synthetic");
    expect(await readMemoryExport(file)).toMatchObject({
      name: "synthetic.md",
      content: "# Synthetic",
      sourceIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const link = join(folder, "link.md");
    await symlink(file, link);
    await expect(readMemoryExport(link)).rejects.toThrow();
    await expect(readMemoryExport(folder)).rejects.toThrow();
  });
  it("rejects oversized exports before reading content", async () => {
    folder = await mkdtemp(join(tmpdir(), "matrix-memory-export-"));
    const file = join(folder, "large.txt");
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(readMemoryExport(file)).rejects.toThrow("Invalid export");
  });
});
describe("supported read-only macOS automation", () => {
  it("keeps Mail identity stable when a mailbox moves or is renamed and separates accounts", () => {
    let mailboxName = "Inbox", accountId = "account-one", itemId = 1;
    const message = { id: () => itemId, messageId: () => "<stable@example.test>", subject: () => "Synthetic", content: () => "Synthetic body", dateReceived: () => new Date("2026-10-05T00:00:00Z"), sender: () => "test@example.test" };
    const mailbox = { name: () => mailboxName, mailboxes: [], messages: [message] };
    const app = { accounts: [{ id: () => accountId, name: () => "Account", mailboxes: [mailbox] }], mailboxes: [] };
    const run = new Function("Application", `${MEMORY_IMPORT_SCRIPT}; return run;`)(() => app);
    const preview = () => {
      const inventory = JSON.parse(run([JSON.stringify({ provider: "mail", action: "inventory", input: {} })]));
      return JSON.parse(run([JSON.stringify({ provider: "mail", action: "preview", input: { collectionIds: [inventory.collections[0].id], limit: 10 } })])).records[0];
    };
    const original = preview();
    mailboxName = "Archive";
    itemId = 99;
    expect(preview().externalId).toBe(original.externalId);
    accountId = "account-two";
    expect(preview().externalId).not.toBe(original.externalId);
  });
  it("retains the bounded part of a large preview and warns instead of discarding everything", () => {
    let reads = 0;
    const notes = Array.from({ length: 25 }, (_, i) => ({ id: () => `note-${i}`, name: () => `Synthetic ${i}`, modificationDate: () => new Date("2026-10-05T00:00:00Z"), passwordProtected: () => false, plaintext: () => { reads++; return "x".repeat(64000); } }));
    const app = { accounts: [{ id: () => "account", name: () => "Synthetic", folders: [{ id: () => "folder", name: () => "Folder", folders: [], notes }] }] };
    const run = new Function("Application", `${MEMORY_IMPORT_SCRIPT}; return run;`)(() => app);
    const result = JSON.parse(run([JSON.stringify({ provider: "notes", action: "preview", input: { collectionIds: ["folder"], limit: 100 } })]));
    expect(result.records).toHaveLength(15);
    expect(result.records.reduce((n: number, r: { content: string }) => n + r.content.length, 0)).toBeLessThanOrEqual(1000000);
    expect(result.warnings).toContain("Preview reached the content size limit. Remaining items were omitted; narrow your selection for another preview.");
    expect(reads).toBe(16);
  });
  it("lists metadata first and reads only selected unlocked notes", () => {
    let bodyReads = 0;
    const note = (id: string, locked = false) => ({
      id: () => id,
      name: () => id,
      modificationDate: () => new Date("2026-10-05T00:00:00Z"),
      passwordProtected: () => locked,
      plaintext: () => {
        bodyReads++;
        return "Synthetic content";
      },
    });
    const folder = (id: string, notes: unknown[]) => ({
      id: () => id,
      name: () => id,
      folders: [],
      notes,
    });
    const app = {
      accounts: [
        {
          id: () => "account",
          name: () => "Synthetic",
          folders: [
            folder("selected", [note("one"), note("locked", true)]),
            folder("other", [note("private")]),
          ],
        },
      ],
    };
    const run = new Function(
      "Application",
      `${MEMORY_IMPORT_SCRIPT}; return run;`,
    )(() => app);
    const invoke = (action: string, input: unknown) =>
      JSON.parse(run([JSON.stringify({ provider: "notes", action, input })]));
    expect(invoke("inventory", {}).collections).toHaveLength(2);
    expect(bodyReads).toBe(0);
    const result = invoke("preview", {
      collectionIds: ["selected"],
      limit: 10,
    });
    expect(result.records).toHaveLength(1);
    expect(bodyReads).toBe(1);
    expect(result.warnings).toContain("Locked notes are omitted.");
    expect(result.records[0].metadata).toEqual({ attachmentsOmitted: "true" });
  });
});
