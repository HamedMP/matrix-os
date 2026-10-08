import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainFeatureError, type BrainResolvedProject } from "../../packages/gateway/src/brain/contracts.js";
import { createMatrixFilesAdapter } from "../../packages/gateway/src/brain/sources/matrix/files.js";
import { readTextFile, compareSegments } from "../../packages/gateway/src/brain/sources/matrix/files-walk.js";
import { isSecretLikeName, isSecretLikeText } from "../../packages/gateway/src/brain/sources/matrix/config.js";
import { encodeMatrixCursor, matrixDocumentId } from "../../packages/gateway/src/brain/sources/matrix/shared.js";
import {
  bootstrapBrainMatrixDatabase, createBrainMatrixFilesHandler,
} from "../../packages/gateway/src/brain/sources/matrix/index.js";
import { createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";
import { createMatrixSource, liveTitles, matrixScope, runMatrixLoop, wideLimits } from "./helpers/brain-source-matrix-loop.js";

const project: BrainResolvedProject = { projectId: "proj_a", slug: "a", name: "A", scope: matrixScope };
let home: string;
let outside: string;
let harness: BrainHarness;

function put(path: string, content: string | Buffer) {
  mkdirSync(join(home, path, ".."), { recursive: true });
  writeFileSync(join(home, path), content);
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "brain-matrix-home-"));
  outside = mkdtempSync(join(tmpdir(), "brain-matrix-outside-"));
  harness = await createBrainHarness();
  await bootstrapBrainMatrixDatabase(harness.db);
});
afterEach(async () => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  await harness.destroy();
});

async function setup(rawConfig: unknown) {
  const handler = createBrainMatrixFilesHandler({ kysely: harness.db, homePath: home, now: harness.now });
  const config = handler.parseConfig(rawConfig);
  const { externalRef } = handler.identify(project, config);
  const sourceId = await createMatrixSource(harness, "matrix_files", externalRef);
  const resolution = await handler.createAdapter("owner_a", project, config);
  if (!resolution.ok) throw new Error("adapter");
  return { handler, config, externalRef, sourceId, adapter: resolution.adapter };
}

describe("matrix files source", () => {
  it("walks text files page by page, skips what it must and tombstones what is gone", async () => {
    put("projects/app/README.md", "# App\n");
    put("projects/app/src/a.ts", "export const a = 1;\n");
    put("projects/app/src/b.bin", "not selected");
    put("projects/app/src/c.ts", Buffer.from([0x61, 0x00, 0x62]));
    put("projects/app/src/d.ts", Buffer.from([0xff, 0xfe]));
    put("projects/app/big.md", "x".repeat(300));
    put("projects/app/empty.md", "  \n");
    put("projects/app/long.md", "y".repeat(70_000));
    put("projects/app/.hidden/x.md", "hidden");
    put("projects/app/Makefile", "all:");
    put(`projects/app/${"t".repeat(200)}/${"u".repeat(150)}.md`, "long path");
    put("projects/app/node_modules/x.md", "dependency");
    writeFileSync(join(outside, "secret.md"), "secret");
    symlinkSync(join(outside, "secret.md"), join(home, "projects/app/link.md"));
    symlinkSync(outside, join(home, "projects/app/linked-dir"));
    const { adapter, config, externalRef, sourceId, handler } = await setup({
      roots: ["projects/app/", "notes"], extensions: [".MD", "ts"], maxFileBytes: 100_000,
    });
    const small = { ...config, maxFileBytes: 200 };
    const first = await runMatrixLoop(harness, sourceId, externalRef, adapter, small, { limits: { ...wideLimits, maxUpserts: 1 } });
    expect(first.caughtUp).toBe(true);
    expect(first.notices.sort()).toEqual(["binary_skipped", "too_large_skipped"]);
    expect(await liveTitles(harness, sourceId)).toEqual([
      `...${`projects/app/${"t".repeat(200)}/${"u".repeat(150)}.md`.slice(-297)}`, "projects/app/README.md", "projects/app/src/a.ts",
    ]);

    const full = await runMatrixLoop(harness, sourceId, externalRef, adapter, config);
    expect(full.written).toBe(2);
    expect(await handler.loadConfig(matrixScope, sourceId)).toBeNull();
    expect(full.notices.sort()).toEqual(["binary_skipped", "body_truncated"]);
    const docs = (await harness.repository.listDocuments(matrixScope, { sourceId })).items;
    const long = docs.find((doc) => doc.title === "projects/app/long.md")!;
    expect(await harness.repository.listDocumentRefs(matrixScope, long.documentId)).toEqual([
      { kind: "file", value: "projects/app/long.md" },
    ]);

    rmSync(join(home, "projects/app/README.md"));
    put("projects/app/src/a.ts", Buffer.from([0x00]));
    const after = await runMatrixLoop(harness, sourceId, externalRef, adapter, { ...config, extensions: ["ts"] });
    expect(after).toMatchObject({ caughtUp: true, deleted: 5 });
    expect(await liveTitles(harness, sourceId)).toEqual([]);
  });

  it("tombstones files that vanished, moved behind a symlink or left the roots", async () => {
    put("docs/a.md", "a");
    put("docs/sub/b.md", "b");
    put("docs/c.md", "c");
    put("notes/d.md", "d");
    const { adapter, config, externalRef, sourceId } = await setup({ roots: ["docs", "notes"] });
    expect((await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).written).toBe(4);
    rmSync(join(home, "docs/a.md"));
    renameSync(join(home, "docs/sub"), join(home, "docs/real"));
    symlinkSync(join(home, "docs/real"), join(home, "docs/sub"));
    const result = await runMatrixLoop(harness, sourceId, externalRef, adapter, { ...config, roots: ["docs"] }, {
      limits: { ...wideLimits, maxDeletions: 1 },
    });
    expect(result).toMatchObject({ caughtUp: true, written: 1, deleted: 3 });
    expect(await liveTitles(harness, sourceId)).toEqual(["docs/c.md", "docs/real/b.md"]);
  });

  it("resumes inside huge folders and leaves out deep and long paths", async () => {
    for (let index = 0; index <= 5_000; index += 1) mkdirSync(join(home, "big/a", `d${index}`), { recursive: true });
    put("big/b.md", "last");
    put(`big/deep/${Array.from({ length: 12 }, (_, i) => `l${i}`).join("/")}/x.md`, "too deep");
    put(`big/${"n".repeat(250)}/${"m".repeat(250)}/${"o".repeat(20)}.md`, "too long");
    const { adapter, config, externalRef, sourceId, handler } = await setup({ roots: ["big"] });
    const result = await runMatrixLoop(harness, sourceId, externalRef, adapter, config);
    expect(result).toMatchObject({ caughtUp: true, written: 1, notices: ["items_truncated"] });
    expect(result.pages).toBeGreaterThan(2);
    // The folder picker reads at most dirEntriesMax entries: the 5,001 folders end at offset 5,000.
    const cursor = encodeMatrixCursor("mo1:", { v: 1, offset: 4_900 });
    const last = await handler.listOptions!("owner_a", project, { q: "big/a", cursor }, new AbortController().signal);
    expect(last.items).toHaveLength(100);
    expect(last.nextCursor).toBeNull();
  });

  it("cuts long titles and labels without leaving half of an emoji", async () => {
    // 303 characters: the last 297 start with the second half of an emoji, which the title drops.
    const path = `docs/${"\u{1F600}".repeat(60)}/${"x".repeat(174)}.md`;
    put(path, "emoji path");
    const { adapter, config, externalRef, sourceId, handler } = await setup({ roots: ["docs"] });
    expect(await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).toMatchObject({ caughtUp: true, written: 1 });
    expect(await liveTitles(harness, sourceId)).toEqual([`...${path.slice(-296)}`]);
    // 210 characters come before the emojis, so the 297-character cut ends inside one.
    const label = handler.identify(project, { ...config, roots: ["r".repeat(200), `s${"\u{1F600}".repeat(100)}`] }).label;
    expect(label).toBe(`Files: ${"r".repeat(200)}, s${"\u{1F600}".repeat(43)}...`);
  });

  it("ends a page at the byte budget, counting binary files too", async () => {
    for (let index = 0; index < 18; index += 1) put(`bin/f${String(index).padStart(2, "0")}.txt`, Buffer.alloc(1_000_000));
    const { adapter, config, externalRef, sourceId } = await setup({ roots: ["bin"], extensions: ["txt"], maxFileBytes: 1_048_576 });
    // 16 files fill 16,000,000 of the 16 MiB budget; the 17th does not fit and waits for the next page.
    const first = await runMatrixLoop(harness, sourceId, externalRef, adapter, config, { maxPages: 1 });
    expect(first).toMatchObject({ pages: 1, caughtUp: false, skipped: 16, notices: ["binary_skipped"] });
    expect(await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).toMatchObject({ caughtUp: true, skipped: 2 });
  });

  it("never reads names that look like credentials and tombstones their earlier documents", async () => {
    put("projects/app/notes.md", "notes");
    put("projects/app/secretary.md", "kept");
    put("projects/app/config/credentials.json", "{}");
    put("projects/app/service-account.json", "{}");
    put("projects/app/secrets.yaml", "a: b");
    put("projects/app/deploy/token.txt", "t");
    put("projects/app/certs/server.pem", "pem");
    put("projects/app/private/secrets/x.md", "x");
    put("projects/app/firebase.json", '{"type": "service_account", "private_key": "k"}');
    put("projects/app/deploy.md", `-----BEGIN OPENSSH PRIVATE KEY-----\nabc`);
    const { adapter, config, externalRef, sourceId, handler } = await setup({
      roots: ["projects/app"], extensions: ["json", "md", "pem", "txt", "yaml"],
    });
    const earlier = ["projects/app/secrets.yaml", "projects/app/private/secrets/x.md", "projects/app/deploy.md"].map((path) => ({
      documentId: matrixDocumentId("matrix_files", externalRef, [path]), title: path, body: "old", permalink: "",
      sourceUpdatedAt: harness.iso(), provenance: "matrix_file", refs: [{ kind: "file", value: path }],
    }));
    await harness.repository.applySyncBatch(matrixScope, {
      sourceId, expectedCursor: null, nextCursor: encodeMatrixCursor("mf1:", { v: 1, phase: "scan", root: "", after: null }),
      upserts: earlier, deletions: [],
    });
    const result = await runMatrixLoop(harness, sourceId, externalRef, adapter, config);
    expect(result).toMatchObject({ caughtUp: true, written: 2, deleted: 3, skipped: 7, notices: ["secret_skipped"] });
    expect(await liveTitles(harness, sourceId)).toEqual(["projects/app/notes.md", "projects/app/secretary.md"]);
    for (const roots of [["projects/secrets"], ["app/api-keys/x"]]) expect(() => handler.parseConfig({ roots })).toThrow(BrainFeatureError);
    expect(["token.ts", "my_api_key.txt", "id.P12", "Passwords.md", "serviceAccountKey.json", "gcp-sa-key.json",
      "firebase-adminsdk-abc12-1234567890.json", "google-services.json", "kubeconfig.yaml", "id_rsa", "prod.tfvars",
    ].every(isSecretLikeName)).toBe(true);
    expect(["AKIA" + "ABCDEFGHIJKLMNOP", `ghp_${"a".repeat(36)}`, "xoxb-1234567890-abc", `sk-ant-${"a".repeat(24)}`]
      .every(isSecretLikeText)).toBe(true);
    expect(isSecretLikeText('{"type": "service_account"}')).toBe(false);
    expect(["tokenizer.ts", "keys.md", "secretary.md", "README.md"].some(isSecretLikeName)).toBe(false);
  });

  it("says secret_skipped for a file skipped by its content alone, and not for a plain skip", async () => {
    put("keys/deploy.md", `-----BEGIN OPENSSH PRIVATE KEY-----\nabc`);
    put("plain/empty.md", " ");
    const keys = await setup({ roots: ["keys"], extensions: ["md"] });
    expect(await runMatrixLoop(harness, keys.sourceId, keys.externalRef, keys.adapter, keys.config))
      .toMatchObject({ written: 0, skipped: 1, notices: ["secret_skipped"] });
    const plain = await setup({ roots: ["plain"], extensions: ["md"] });
    expect(await runMatrixLoop(harness, plain.sourceId, plain.externalRef, plain.adapter, plain.config))
      .toMatchObject({ written: 0, skipped: 1, notices: [] });
  });

  it("sweeps foreign documents and stops for an aborted run", async () => {
    put("docs/a.md", "a");
    const { adapter, config, externalRef, sourceId } = await setup({ roots: ["docs"] });
    const controller = new AbortController();
    controller.abort();
    const aborted = await runMatrixLoop(harness, sourceId, externalRef, adapter, config, { signal: controller.signal, maxPages: 1 });
    expect(aborted).toMatchObject({ pages: 1, written: 0, caughtUp: false });
    await harness.repository.applySyncBatch(matrixScope, {
      sourceId, expectedCursor: (await harness.repository.getSyncCursor(matrixScope, sourceId))!.cursor, nextCursor: "mf1:x",
      upserts: [{ documentId: "f".repeat(64), title: "stray", body: "b", permalink: "", sourceUpdatedAt: harness.iso(), provenance: "matrix_file" }],
      deletions: [],
    });
    expect((await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).failure).toEqual({ ok: false, code: "cursor_invalid" });
    const sweep = encodeMatrixCursor("mf1:", { v: 1, phase: "sweep", after: null });
    await harness.repository.applySyncBatch(matrixScope, { sourceId, expectedCursor: "mf1:x", nextCursor: sweep, upserts: [], deletions: [] });
    expect(await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).toMatchObject({ deleted: 1, caughtUp: true });
    expect(await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).toMatchObject({ written: 1 });
  });

  it("refuses roots reached through symlinks, a root that is a file and a missing home", async () => {
    symlinkSync(outside, join(home, "escape"));
    put("plain", "file");
    for (const root of ["escape", "plain"]) {
      const { adapter, config, externalRef, sourceId } = await setup({ roots: [root] });
      expect((await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).failure).toEqual({ ok: false, code: "path_unsafe" });
    }
    const gone = createMatrixFilesAdapter(join(home, "missing"));
    const sourceId = await createMatrixSource(harness, "matrix_files", "matrix_files:gone");
    expect((await runMatrixLoop(harness, sourceId, "matrix_files:gone", gone, { roots: ["x"], extensions: ["md"], maxFileBytes: 10 })).failure)
      .toEqual({ ok: false, code: "path_unsafe" });
    put("home-file", "x");
    const notDir = createMatrixFilesAdapter(join(home, "home-file"));
    expect((await runMatrixLoop(harness, sourceId, "matrix_files:gone", notDir, { roots: ["x"], extensions: ["md"], maxFileBytes: 10 })).failure)
      .toEqual({ ok: false, code: "path_unsafe" });
  });

  it("reads single files defensively and orders paths by segment", async () => {
    mkdirSync(join(home, "dir"));
    expect(await readTextFile(join(home, "dir"), 10)).toEqual({ kind: "gone" });
    expect(await readTextFile(join(home, "none.md"), 10)).toEqual({ kind: "gone" });
    expect(compareSegments(["a"], ["a", "b"])).toBeLessThan(0);
    expect(compareSegments(["b"], ["a", "z"])).toBeGreaterThan(0);
  });

  it("parses roots strictly and lists folders to pick", async () => {
    const handler = createBrainMatrixFilesHandler({ kysely: harness.db, homePath: home });
    expect(handler.parseConfig({ roots: ["b", "a/x/"] })).toMatchObject({ roots: ["a/x", "b"], maxFileBytes: 262_144 });
    const bad = [
      ["/abs"], ["../x"], ["system/x"], [".ssh"], ["a//b"], ["data"], ["data/browser-profiles/x"], ["a", "a/b"], [""],
      ["a\\b"], ["x".repeat(300)], ["agents"], ["a/node_modules"],
    ];
    for (const roots of bad) expect(() => handler.parseConfig({ roots })).toThrow(BrainFeatureError);
    expect(() => handler.parseConfig({ roots: ["a"], maxFileBytes: 2_000_000 })).toThrow(BrainFeatureError);
    expect(() => handler.parseConfig({ roots: ["a"], extensions: ["m d"] })).toThrow(BrainFeatureError);
    const config = handler.parseConfig({ roots: ["a"], extensions: ["md"] });
    expect(handler.identify(project, config).externalRef).toMatch(/^matrix_files:[a-f0-9]{32}$/);
    expect(handler.identify(project, config).label).toBe("Files: a");
    expect(handler.identify(project, { ...config, roots: ["r".repeat(200), "s".repeat(200)] }).label).toHaveLength(300);
    expect(handler.viewConfig(config)).toEqual({ roots: ["a"], extensions: ["md"], maxFileBytes: 262_144 });
    expect(await handler.availability("owner_a")).toEqual({ available: true });
    expect(await createBrainMatrixFilesHandler({ kysely: harness.db, homePath: "" }).availability("owner_a"))
      .toEqual({ available: false, reason: "not_configured" });
    const sourceId = await createMatrixSource(harness, "matrix_files", "matrix_files:a");
    await handler.saveConfig(matrixScope, sourceId, config);
    expect(await handler.loadConfig(matrixScope, sourceId)).toEqual(config);

    for (const name of ["projects", "system", ".ssh", "data", "notes", "secrets"]) mkdirSync(join(home, name));
    for (let index = 0; index < 101; index += 1) mkdirSync(join(home, "projects", `p${String(index).padStart(3, "0")}`));
    const signal = new AbortController().signal;
    const top = await handler.listOptions!("owner_a", project, {}, signal);
    expect(top.items.map((item) => item.id)).toEqual(["notes", "projects"]);
    const first = await handler.listOptions!("owner_a", project, { q: "projects" }, signal);
    expect(first.items).toHaveLength(100);
    expect(first.items[0]).toEqual({ id: "projects/p000", label: "p000", detail: "projects/p000" });
    const second = await handler.listOptions!("owner_a", project, { q: "projects", cursor: first.nextCursor! }, signal);
    expect(second).toEqual({ kind: "matrix_files", items: [{ id: "projects/p100", label: "p100", detail: "projects/p100" }], nextCursor: null });
    expect(await handler.listOptions!("owner_a", project, { q: "missing" }, signal)).toMatchObject({ items: [] });
    await expect(handler.listOptions!("owner_a", project, { q: "../x" }, signal)).rejects.toThrow(BrainFeatureError);
    await expect(handler.listOptions!("owner_a", project, { cursor: "bad" }, signal)).rejects.toThrow(BrainFeatureError);

    // A folder behind a symlink, a file or a missing home is bad input; an unreadable folder has no sub-folders.
    symlinkSync(outside, join(home, "escape"));
    put("plain", "file");
    const homeless = createBrainMatrixFilesHandler({ kysely: harness.db, homePath: join(home, "missing") });
    for (const [owner, q] of [[handler, "escape"], [handler, "plain"], [homeless, ""]] as const) {
      await expect(owner.listOptions!("owner_a", project, { q }, signal)).rejects.toMatchObject({ code: "source_config_invalid" });
    }
    mkdirSync(join(home, "locked/inner"), { recursive: true });
    chmodSync(join(home, "locked"), 0o000);
    try {
      expect(await handler.listOptions!("owner_a", project, { q: "locked" }, signal)).toMatchObject({ items: [], nextCursor: null });
    } finally {
      chmodSync(join(home, "locked"), 0o755);
    }
  });
});
