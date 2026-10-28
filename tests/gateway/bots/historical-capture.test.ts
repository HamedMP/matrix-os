import { chmod, mkdtemp, mkdir, writeFile, rm, symlink, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prepareBotInputs } from "../../../packages/gateway/src/bots/admitted-input.js";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import type { HistoricalInput } from "../../../packages/gateway/src/bots/historical-input.js";
const captureHooks = vi.hoisted(() => ({
  opened: undefined as ((file: FileHandle) => void) | undefined,
  lstat: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args); captureHooks.opened?.(file); return file;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      await captureHooks.lstat?.(String(args[0])); return actual.lstat(...args);
    },
  };
});
let home: string;
const authority = { ownerId: "owner_1", chatId: "chat_1", runId: "run_1" };
const binding = { ...authority, runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1" } as never;
const route = { api: "openai-responses" as const, modelId: "vision", input: ["text", "image"] as ("text" | "image")[], contextWindow: 128000, maxOutputTokens: 8192 };
const png = Buffer.from([137,80,78,71,13,10,26,10, 91]);
function ref(name: string, kind: "file" | "image" = "file", seq = 1): HistoricalInput {
  return { seq, part: { type: "attachment_reference", attachmentId: `att_${name}`, ownerReference: `temporary/desktop-chat/${name}`, kind, mimeType: kind === "file" ? "text/plain" : "image/png", label: name } };
}
function prepare(references: HistoricalInput[], overrides: Partial<Parameters<typeof prepareBotInputs>[0]> = {}) {
  return prepareBotInputs({ homePath: home, expectedOwnerId: authority.ownerId, ...authority, parts: [{ type: "text", text: "Read again" }], route,
    signal: new AbortController().signal, assertActive: () => undefined, history: async () => ({ references, assertCurrent: async () => undefined }), ...overrides });
}
beforeEach(async () => { captureHooks.opened = undefined; captureHooks.lstat = undefined; home = await realpath(await mkdtemp(join(tmpdir(), "history-input-"))); await mkdir(join(home, "temporary/desktop-chat"), { recursive: true }); });
afterEach(async () => { captureHooks.opened = undefined; captureHooks.lstat = undefined; vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });
it("captures independently changed same-size file bytes with new aliases; denies stale alias and generation", async () => {
  const path = join(home, "temporary/desktop-chat/marker"); await writeFile(path, "NEW_UNSEEN_MARKER");
  const first = await prepare([ref("marker")]); first.bind(binding); const old = first.fileAliases[0]!; first.dispose();
  await writeFile(path, "FRESH_BYTE_PROOF!");
  const next = await prepare([ref("marker")]); next.bind(binding);
  expect(next.fileAliases[0]).not.toBe(old); expect(await next.readArtifact(binding, { relPath: next.fileAliases[0]! })).toBe("FRESH_BYTE_PROOF!");
  await expect(next.readArtifact(binding, { relPath: old })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(next.readArtifact({ ...binding, executionGeneration: "2" }, { relPath: next.fileAliases[0]! })).rejects.toMatchObject({ code: "stale_generation" }); next.dispose();
});
it("gives current uploads priority, deduplicates ID and storage reference, caps at eight", async () => {
  const references = Array.from({ length: 10 }, (_, i) => ref(`f${i}`, "file", 20 - i));
  for (const { part } of references) await writeFile(join(home, part.ownerReference!), "fixture");
  const current = ref("f9").part;
  const prepared = await prepare([{ ...ref("f0"), part: { ...ref("f0").part, attachmentId: current.attachmentId } }, ...references], { parts: [current] });
  expect(prepared.fileAliases).toHaveLength(8); expect(prepared.prompt("Read")).toContain("unavailable for this request");
  expect(prepared.prompt("Read")).toContain('current request, "f9"'); expect(prepared.prompt("Read")).not.toContain('history sequence 1, "f0"'); prepared.dispose();
});
it("preserves text turns for missing, symlink, unsupported and overbudget history with a safe index", async () => {
  await writeFile(join(home, "outside"), "SECRET"); await symlink(join(home, "outside"), join(home, "temporary/desktop-chat/link"));
  await writeFile(join(home, "temporary/desktop-chat/big"), Buffer.alloc(10 * 1024 * 1024 + 1));
  const prepared = await prepare([ref("missing"), ref("link"), ref("big"), { ...ref("gif", "image"), part: { ...ref("gif", "image").part, mimeType: "image/gif" } }]);
  expect(prepared.fileAliases).toEqual([]); expect(prepared.imageCount).toBe(0); expect(prepared.prompt("Normal text")).toContain("Normal text");
  expect(prepared.prompt("Normal text").match(/unavailable for this request/g)).toHaveLength(4); expect(prepared.prompt("Normal text")).not.toContain(home); prepared.dispose();
});
it("does not hydrate history images on text-only routes or files without current artifact.read authority", async () => {
  const prepared = await prepare([ref("photo", "image"), ref("marker")], { route: { ...route, input: ["text"] }, historyFileRead: false });
  expect(prepared.imageCount).toBe(0); expect(prepared.fileAliases).toEqual([]); prepared.dispose();
});
it("enforces actual byte aggregate, four images, and the funded one-MiB image limit", async () => {
  const images = Array.from({ length: 5 }, (_, i) => ref(`img${i}`, "image", 20 - i));
  for (const { part } of images) await writeFile(join(home, part.ownerReference!), Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 - png.length)]));
  const imageOnly = await prepare(images); expect(imageOnly.imageCount).toBe(4); imageOnly.dispose();
  await writeFile(join(home, "temporary/desktop-chat/current"), Buffer.alloc(10 * 1024 * 1024));
  await writeFile(join(home, "temporary/desktop-chat/current2"), Buffer.alloc(4 * 1024 * 1024));
  const prepared = await prepare(images, { parts: [ref("current").part, ref("current2").part] }); expect(prepared.imageCount).toBe(3); prepared.dispose();
  const funded = await prepare(images, { imageTotalMaximum: 1024 * 1024 }); expect(funded.imageCount).toBe(0); funded.dispose();
});
it("rechecks identity during capture and revokes captured data before subsequent chunk/tool reads", async () => {
  await writeFile(join(home, "temporary/desktop-chat/photo"), png);
  const assertCurrent = vi.fn(async () => { if (assertCurrent.mock.calls.length === 3) throw new BotBrokerActionError("stale_generation"); });
  await expect(prepare([ref("photo", "image")], { history: async () => ({ references: [ref("photo", "image")], assertCurrent }) })).rejects.toMatchObject({ code: "stale_generation" });
  let live = true; const prepared = await prepare([ref("photo", "image")], { history: async () => ({ references: [ref("photo", "image")], assertCurrent: async () => { if (!live) throw new BotBrokerActionError("stale_generation"); } }) });
  prepared.bind(binding); live = false;
  await expect(prepared.readImageChunk(binding, { index: 0, offset: 0 })).rejects.toMatchObject({ code: "stale_generation" }); prepared.dispose();
});
it("bounds failed historical capture attempts independently of the successful byte budget", async () => {
  const assertCurrent = vi.fn(async () => undefined);
  const references = Array.from({ length: 2560 }, (_, i) => ref(`missing-${i}`, "file", 2560 - i));
  const prepared = await prepare(references, { history: async () => ({ references, assertCurrent }) });
  expect(assertCurrent).toHaveBeenCalledTimes(42); // Initial + forty capture attempts + final fence.
  expect(prepared.prompt("Read").match(/unavailable for this request/g)).toHaveLength(40);
  prepared.dispose();
});
it("keeps a near-limit text request usable when historical notices do not fit", async () => {
  const prepared = await prepare([ref("missing")]);
  const text = "x".repeat(64 * 1024);
  expect(prepared.prompt(text)).toBe(text);
  prepared.dispose();
});
it("omits only historical mounts if their required aliases cannot fit the current text prompt", async () => {
  await writeFile(join(home, "temporary/desktop-chat/marker"), "HISTORY_MARKER");
  await writeFile(join(home, "temporary/desktop-chat/photo"), png);
  const prepared = await prepare([ref("marker"), ref("photo", "image")]);
  const text = "x".repeat(64 * 1024);
  expect(prepared.prompt(text)).toBe(text);
  expect(prepared.fileAliases).toEqual([]); expect(prepared.imageCount).toBe(0);
  prepared.dispose();
});
it("bounds the safe historical advisory index to four KiB without truncating the base text", async () => {
  const references = Array.from({ length: 40 }, (_, i) => ({ ...ref(`missing-${i}`),
    part: { ...ref(`missing-${i}`).part, label: "label".repeat(48) } }));
  const prepared = await prepare(references);
  const text = "Current text must remain exact.";
  const prompt = prepared.prompt(text);
  expect(prompt.startsWith(`${text}\n`)).toBe(true);
  expect(prompt.length - text.length - 1).toBeLessThanOrEqual(4 * 1024);
  expect(prompt).toContain("unavailable for this request"); prepared.dispose();
});
it("keeps current uploads strict when their required metadata exceeds the prompt limit", async () => {
  await writeFile(join(home, "temporary/desktop-chat/current"), "CURRENT");
  const prepared = await prepare([], { parts: [ref("current").part] });
  expect(() => prepared.prompt("x".repeat(64 * 1024))).toThrow(BotBrokerActionError);
  expect(prepared.fileAliases).toHaveLength(1); prepared.dispose();
});
it.skipIf(process.getuid?.() === 0)("omits an unreadable historical file while current unreadable uploads fail strictly", async () => {
  const path = join(home, "temporary/desktop-chat/unreadable");
  await writeFile(path, "PRIVATE_BYTES"); await chmod(path, 0);
  try {
    const prepared = await prepare([ref("unreadable")]);
    expect(prepared.fileAliases).toEqual([]);
    expect(prepared.prompt("Normal text")).toContain("unavailable for this request"); prepared.dispose();
    await expect(prepare([], { parts: [ref("unreadable").part] })).rejects.toMatchObject({ code: "invalid_arguments" });
  } finally { await chmod(path, 0o600); }
});
it.each(["home", "temporary", "desktop-chat"])("keeps text usable when the %s upload directory disappears before open, while current input fails safely", async directory => {
  const path = directory === "home" ? home : join(home, directory === "temporary" ? "temporary" : "temporary/desktop-chat");
  await rm(path, { recursive: true });
  const prepared = await prepare([ref("expired")]);
  expect(prepared.fileAliases).toEqual([]); expect(prepared.prompt("Unrelated text")).toContain("Unrelated text");
  expect(prepared.prompt("Unrelated text")).toContain("unavailable for this request");
  expect(prepared.prompt("Unrelated text")).not.toContain(home); prepared.dispose();
  await expect(prepare([], { parts: [ref("expired").part] })).rejects.toMatchObject({ code: "invalid_arguments" });
});
it.each([true, false])("closes the pinned descriptor after cleanup unlinks the upload during capture (historical=%s)", async historical => {
  const path = join(home, "temporary/desktop-chat/racing"); await writeFile(path, "RETAINED_BYTES");
  let descriptor: FileHandle | undefined, closed: ReturnType<typeof vi.spyOn> | undefined;
  captureHooks.opened = file => {
    descriptor = file; closed = vi.spyOn(file, "close"); const stat = file.stat.bind(file);
    vi.spyOn(file, "stat").mockImplementationOnce(async () => { const info = await stat(); await rm(path); return info; });
  };
  try {
    if (historical) {
      const prepared = await prepare([ref("racing")]);
      expect(prepared.fileAliases).toEqual([]); expect(prepared.prompt("Continue text")).toContain("unavailable for this request"); prepared.dispose();
    } else await expect(prepare([], { parts: [ref("racing").part] })).rejects.toMatchObject({ code: "invalid_arguments" });
  } finally { expect(closed).toHaveBeenCalledOnce(); expect(descriptor?.fd).toBe(-1); }
});
it("keeps historical fallback safe when cleanup removes the directory during final identity checks", async () => {
  const directory = join(home, "temporary/desktop-chat"), path = join(directory, "late"); await writeFile(path, "LATE_BYTES");
  let targetChecked = false, removed: Promise<void> | undefined, closed: ReturnType<typeof vi.spyOn> | undefined;
  captureHooks.opened = file => { closed = vi.spyOn(file, "close"); };
  captureHooks.lstat = async current => {
    if (current === path) targetChecked = true;
    else if (targetChecked) { removed ??= rm(directory, { recursive: true }); await removed; }
  };
  const prepared = await prepare([ref("late")]);
  expect(prepared.fileAliases).toEqual([]); expect(prepared.prompt("Continue text")).toContain("unavailable for this request"); prepared.dispose();
  expect(closed).toHaveBeenCalledOnce();
});
it.each(["EIO", "ENOMEM"])("propagates unexpected %s during final path verification and closes the descriptor", async code => {
  const path = join(home, "temporary/desktop-chat/error"); await writeFile(path, "ERROR_BYTES");
  const failure = Object.assign(new Error("Synthetic filesystem failure"), { code }); let closed: ReturnType<typeof vi.spyOn> | undefined;
  captureHooks.opened = file => { closed = vi.spyOn(file, "close"); };
  captureHooks.lstat = async current => { if (current === path) throw failure; };
  await expect(prepare([ref("error")])).rejects.toBe(failure); expect(closed).toHaveBeenCalledOnce();
});
it.each(["not_granted", "denied", "stale_generation"] as const)("does not treat a current authority failure %s as missing history", async code => {
  await writeFile(join(home, "temporary/desktop-chat/authority"), "AUTHORITY_BYTES");
  const failure = new BotBrokerActionError(code); let checks = 0;
  await expect(prepare([ref("authority")], { history: async () => ({ references: [ref("authority")], assertCurrent: async () => { if (++checks === 3) throw failure; } }) })).rejects.toBe(failure);
});
it("does not normalize a filesystem-shaped error from the source authority recheck", async () => {
  const failure = Object.assign(new Error("Synthetic source authority failure"), { code: "ENOENT" }); let checks = 0;
  await expect(prepare([ref("source")], { history: async () => ({ references: [ref("source")], assertCurrent: async () => { if (++checks === 2) throw failure; } }) })).rejects.toBe(failure);
});
it("does not skip a typed invalid-arguments failure from the authority fence as absent history", async () => {
  const failure = new BotBrokerActionError("invalid_arguments"); let checks = 0;
  const opened = vi.fn(); captureHooks.opened = opened;
  await expect(prepare([ref("source")], { history: async () => ({ references: [ref("source")], assertCurrent: async () => { if (++checks === 2) throw failure; } }) })).rejects.toBe(failure);
  expect(opened).not.toHaveBeenCalled();
});
it("propagates cancellation when cleanup also unlinks the captured historical upload", async () => {
  const path = join(home, "temporary/desktop-chat/cancel"); await writeFile(path, "CANCEL_BYTES");
  const controller = new AbortController(); let closed: ReturnType<typeof vi.spyOn> | undefined;
  captureHooks.opened = file => {
    closed = vi.spyOn(file, "close"); const stat = file.stat.bind(file);
    vi.spyOn(file, "stat").mockImplementationOnce(async () => { const info = await stat(); controller.abort(); await rm(path); return info; });
  };
  await expect(prepare([ref("cancel")], { signal: controller.signal })).rejects.toMatchObject({ code: "stale_generation" });
  expect(closed).toHaveBeenCalledOnce();
});
it("keeps current aliases authoritative when eight same-labelled historical uploads cannot be mounted", async () => {
  const current = Array.from({ length: 8 }, (_, i) => ({ ...ref(`current-${i}`).part, label: `same-label-${i}.txt` }));
  const history = current.map((part, i) => ({ ...ref(`old-${i}`, "file", 10 + i), part: { ...ref(`old-${i}`).part, label: part.label } }));
  for (const part of current) await writeFile(join(home, part.ownerReference!), "CURRENT");
  const prepared = await prepare(history, { parts: current }); prepared.bind(binding);
  try {
    expect(prepared.fileAliases).toHaveLength(8);
    const prompt = prepared.prompt("Read only the eight current submitted files.");
    const lastCurrentAlias = prompt.lastIndexOf(prepared.fileAliases[7]!);
    expect(lastCurrentAlias).toBeGreaterThan(0);
    // Notes about unmounted history must not tell the model to discard the
    // working current aliases above them. Same labels do not confer authority.
    expect(prompt.slice(lastCurrentAlias)).not.toContain("supersedes prior aliases");
    expect(prompt).toContain("Submitted files for this request");
    expect(prompt.match(/history sequence \d+, .*unavailable for this request/g)).toHaveLength(8);
    expect(await prepared.readArtifact(binding, { relPath: prepared.fileAliases[0]! })).toBe("CURRENT");
    await expect(prepared.readArtifact(binding, { relPath: "submitted-inputs/stale-alias" })).rejects.toMatchObject({ code: "invalid_arguments" });
  } finally { prepared.dispose(); }
});
