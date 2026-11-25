import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_FILES_BRIDGE_PATH,
  APP_FILES_PERMISSION,
  APP_FILE_ERROR_CODES,
  APP_FILE_ERROR_MESSAGES,
  APP_FILE_ERROR_STATUS,
  APP_FILE_HOME_DIR,
  APP_FILE_LIST_MAX_ENTRIES,
  APP_FILE_MAX_BASE64_CHARS,
  APP_FILE_MAX_BYTES,
  APP_FILE_PATH_MAX_CHARS,
  AppFileDirSchema,
  AppFileErrorBodySchema,
  AppFileInputSchema,
  AppFileListReplySchema,
  AppFileMkdirReplySchema,
  AppFilePathSchema,
  AppFileReadReplySchema,
  AppFileRequestSchema,
  AppFileStatReplySchema,
  AppFileVersionSchema,
  AppFileWriteReplySchema,
  BridgeFileError,
  MAX_APP_FILE_LIST_REPLY_BYTES,
  MAX_APP_FILE_REPLY_BYTES,
  MAX_APP_FILE_REQUEST_BYTES,
  appFileBase64ByteLength,
  appFileErrorBody,
  appFileErrorCodeForStatus,
  appFileReplyBytes,
  appFileRequestBytes,
  appFileVersion,
  createAppFilesClient,
  decodeAppFileBase64,
  encodeAppFileBase64,
  isAppFilePath,
  isAppReachableFilePath,
  isBridgeFileError,
  type AppFileInput,
} from "../../packages/contracts/src/app-files";
import { isDeniedFileApiPath, isProtectedHomeSubpath } from "../../packages/gateway/src/path-security";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
const VERSION = appFileVersion(12, 1_700_000_000_123_456_789n);
const MODIFIED = "2026-11-22T10:15:30.000Z";

describe("app file paths", () => {
  it.each([
    "report.docx",
    "Documents/Contracts/lease v2.docx",
    "projects/q4/budget.final.xlsx",
    "notes/a..b.csv",
    "Dokumente/Übersicht – 2026.xlsx",
    ".config/app/data.csv",
  ])("accepts the home-relative path %j", (path) => {
    expect(isAppFilePath(path)).toBe(true);
    expect(AppFilePathSchema.safeParse(path).success).toBe(true);
  });

  it.each([
    ["an empty path", ""],
    ["an absolute path", "/etc/passwd"],
    ["a parent segment", "Documents/../system/soul.md"],
    ["a bare parent segment", ".."],
    ["a trailing parent segment", "Documents/.."],
    ["a current-directory segment", "./report.docx"],
    ["an inner current-directory segment", "a/./b.docx"],
    ["a backslash separator", "Documents\\report.docx"],
    ["a doubled slash", "Documents//report.docx"],
    ["a trailing slash", "Documents/"],
    ["a NUL byte", "report\0.docx"],
    ["a path above the length cap", `${"a".repeat(APP_FILE_PATH_MAX_CHARS)}b`],
  ])("rejects %s", (_label, path) => {
    expect(isAppFilePath(path)).toBe(false);
    expect(AppFilePathSchema.safeParse(path).success).toBe(false);
  });

  it("accepts a path exactly at the length cap", () => {
    expect(AppFilePathSchema.safeParse("a".repeat(APP_FILE_PATH_MAX_CHARS)).success).toBe(true);
  });

  it("lets only a directory argument name the home root", () => {
    expect(APP_FILE_HOME_DIR).toBe("");
    expect(AppFileDirSchema.safeParse(APP_FILE_HOME_DIR).success).toBe(true);
    expect(AppFileDirSchema.safeParse("Documents").success).toBe(true);
    expect(AppFileDirSchema.safeParse("../other").success).toBe(false);
    expect(AppFileInputSchema.safeParse({ kind: "files.read", path: "" }).success).toBe(false);
  });
});

describe("app reachable paths", () => {
  const HOME = "/home/owner";
  const SAMPLES = [
    "Documents/report.docx", "report.docx", "systems/a.csv", "Documents/system/a.csv", "Documents/.cache/a.csv",
    "system/logs/usage.csv", "system", "agents/x.docx", ".hermes/export.csv", ".trash/a.xlsx", "data/x.csv",
    "data/browser-profiles", "data/browser-profiles/p/a.csv", "data/browser-profiles-old/a.csv",
    "data/app-gallery-staging/x/s.xlsx", "projects/main/sheet.xlsx",
  ];

  it.each(SAMPLES)("agrees with the gateway path rules for %s", (path) => {
    const gatewayRefuses = isProtectedHomeSubpath(HOME, `${HOME}/${path}`) || isDeniedFileApiPath(HOME, path);
    expect(isAppReachableFilePath(path)).toBe(!gatewayRefuses);
  });

  it("refuses paths that are not valid app paths", () => {
    for (const path of ["", "../a.csv", "/abs.csv", "a//b.csv", "a\\b.csv"]) expect(isAppReachableFilePath(path)).toBe(false);
  });
});

describe("app file requests", () => {
  it("parses every request kind and applies the list limit default", () => {
    expect(AppFileInputSchema.parse({ kind: "files.list", dir: "" })).toEqual({ kind: "files.list", dir: "", limit: APP_FILE_LIST_MAX_ENTRIES });
    expect(AppFileInputSchema.parse({ kind: "files.list", dir: "Documents", limit: 25 })).toEqual({ kind: "files.list", dir: "Documents", limit: 25 });
    expect(AppFileInputSchema.parse({ kind: "files.stat", path: "a.docx" })).toEqual({ kind: "files.stat", path: "a.docx" });
    expect(AppFileInputSchema.parse({ kind: "files.read", path: "a.docx" })).toEqual({ kind: "files.read", path: "a.docx" });
    expect(AppFileInputSchema.parse({ kind: "files.mkdir", path: "Documents/New" })).toEqual({ kind: "files.mkdir", path: "Documents/New" });
    expect(AppFileInputSchema.parse({ kind: "files.write", path: "a.docx", contentBase64: "aGk=", ifVersion: null })).toEqual({
      kind: "files.write", path: "a.docx", contentBase64: "aGk=", ifVersion: null,
    });
    expect(AppFileInputSchema.parse({ kind: "files.write", path: "a.docx", contentBase64: "", ifVersion: VERSION, createParents: true })).toEqual({
      kind: "files.write", path: "a.docx", contentBase64: "", ifVersion: VERSION, createParents: true,
    });
  });

  it("bounds the list limit to 1..500", () => {
    expect(APP_FILE_LIST_MAX_ENTRIES).toBe(500);
    for (const limit of [0, 501, 1.5, -1]) {
      expect(AppFileInputSchema.safeParse({ kind: "files.list", dir: "", limit }).success).toBe(false);
    }
    expect(AppFileInputSchema.safeParse({ kind: "files.list", dir: "", limit: 500 }).success).toBe(true);
  });

  it("rejects unknown kinds, unknown keys and identity supplied inside the input", () => {
    expect(AppFileInputSchema.safeParse({ kind: "files.delete", path: "a.docx" }).success).toBe(false);
    expect(AppFileInputSchema.safeParse({ kind: "files.read", path: "a.docx", app: "docs" }).success).toBe(false);
    expect(AppFileInputSchema.safeParse({ kind: "files.read", path: "a.docx", encoding: "utf8" }).success).toBe(false);
    expect(AppFileInputSchema.safeParse({ kind: "files.stat", path: "../a.docx" }).success).toBe(false);
  });

  it("requires an explicit write precondition", () => {
    const base = { kind: "files.write", path: "a.docx", contentBase64: "aGk=" };
    expect(AppFileInputSchema.safeParse(base).success).toBe(false);
    expect(AppFileInputSchema.safeParse({ ...base, ifVersion: undefined }).success).toBe(false);
    expect(AppFileInputSchema.safeParse({ ...base, ifVersion: "" }).success).toBe(false);
    expect(AppFileInputSchema.safeParse({ ...base, ifVersion: "not a version!" }).success).toBe(false);
    expect(AppFileInputSchema.safeParse({ ...base, ifVersion: null }).success).toBe(true);
    expect(AppFileInputSchema.safeParse({ ...base, ifVersion: VERSION }).success).toBe(true);
  });

  it("rejects content that is not canonical base64", () => {
    const write = (contentBase64: string) => AppFileInputSchema.safeParse({ kind: "files.write", path: "a.docx", contentBase64, ifVersion: null }).success;
    expect(write("aGk=")).toBe(true);
    expect(write("aGk")).toBe(false);
    expect(write("aG=k")).toBe(false);
    expect(write("a-_=")).toBe(false);
    expect(write("aGk=\n")).toBe(false);
    expect(write("====")).toBe(false);
  });

  it("accepts a 10 MiB file and rejects one byte more", () => {
    expect(APP_FILE_MAX_BYTES).toBe(10 * 1024 * 1024);
    const atCap = encodeAppFileBase64(new Uint8Array(APP_FILE_MAX_BYTES));
    expect(atCap.length).toBe(APP_FILE_MAX_BASE64_CHARS);
    const request = { app: "docs", input: { kind: "files.write", path: "a.docx", contentBase64: atCap, ifVersion: null } };
    expect(AppFileRequestSchema.safeParse(request).success).toBe(true);
    const overCap = encodeAppFileBase64(new Uint8Array(APP_FILE_MAX_BYTES + 1));
    expect(AppFileInputSchema.safeParse({ ...request.input, contentBase64: overCap }).success).toBe(false);
    // Same character count as the cap, but two more decoded bytes: the byte cap is exact.
    const unpadded = "A".repeat(APP_FILE_MAX_BASE64_CHARS);
    expect(appFileBase64ByteLength(unpadded)).toBe(APP_FILE_MAX_BYTES + 2);
    expect(AppFileInputSchema.safeParse({ ...request.input, contentBase64: unpadded }).success).toBe(false);
  });

  it("binds a trusted app identity in a strict envelope", () => {
    const input = { kind: "files.read", path: "a.docx" };
    expect(AppFileRequestSchema.parse({ app: "docs", input })).toEqual({ app: "docs", input });
    expect(AppFileRequestSchema.safeParse({ app: "../docs", input }).success).toBe(false);
    expect(AppFileRequestSchema.safeParse({ app: "", input }).success).toBe(false);
    expect(AppFileRequestSchema.safeParse({ input }).success).toBe(false);
    expect(AppFileRequestSchema.safeParse({ app: "docs", input, home: "/root" }).success).toBe(false);
  });
});

describe("app file byte budgets", () => {
  // Worst JSON cost per path character: a control character is escaped as six bytes.
  const worstPath = "\u0001".repeat(APP_FILE_PATH_MAX_CHARS);

  it("fits the largest valid write request inside the request cap", () => {
    const body = JSON.stringify({
      app: `a${"/a".repeat(127)}a`,
      input: {
        kind: "files.write", path: worstPath, contentBase64: encodeAppFileBase64(new Uint8Array(APP_FILE_MAX_BYTES)),
        ifVersion: "v".repeat(128), createParents: true,
      },
    });
    expect(AppFileRequestSchema.safeParse(JSON.parse(body)).success).toBe(true);
    expect(utf8Bytes(body)).toBeLessThanOrEqual(MAX_APP_FILE_REQUEST_BYTES);
    expect(appFileRequestBytes("files.write")).toBe(MAX_APP_FILE_REQUEST_BYTES);
    expect(MAX_APP_FILE_REQUEST_BYTES).toBeLessThan(APP_FILE_MAX_BASE64_CHARS + 128 * 1024);
  });

  it("fits the largest valid read reply inside the reply cap", () => {
    const body = JSON.stringify({
      path: worstPath, contentBase64: encodeAppFileBase64(new Uint8Array(APP_FILE_MAX_BYTES)), size: APP_FILE_MAX_BYTES,
      version: "v".repeat(128), mimeType: "x".repeat(127) + "/" + "y".repeat(127),
    });
    expect(AppFileReadReplySchema.safeParse(JSON.parse(body)).success).toBe(true);
    expect(utf8Bytes(body)).toBeLessThanOrEqual(MAX_APP_FILE_REPLY_BYTES);
    expect(appFileReplyBytes("files.read")).toBe(MAX_APP_FILE_REPLY_BYTES);
  });

  it("keeps requests and replies that carry no content on small budgets", () => {
    for (const kind of ["files.list", "files.stat", "files.read", "files.mkdir"] as const) {
      const input = kind === "files.list" ? { kind, dir: worstPath, limit: 500 } : { kind, path: worstPath };
      const body = JSON.stringify({ app: "docs", input });
      expect(utf8Bytes(body)).toBeLessThanOrEqual(appFileRequestBytes(kind));
      expect(appFileRequestBytes(kind)).toBeLessThanOrEqual(64 * 1024);
    }
    for (const kind of ["files.stat", "files.write", "files.mkdir"] as const) {
      expect(appFileReplyBytes(kind)).toBeLessThanOrEqual(256 * 1024);
    }
    expect(appFileReplyBytes("files.list")).toBe(MAX_APP_FILE_LIST_REPLY_BYTES);
    expect(MAX_APP_FILE_LIST_REPLY_BYTES).toBeLessThan(MAX_APP_FILE_REPLY_BYTES);
  });
});

describe("app file replies", () => {
  const entry = { name: "report.docx", path: "Documents/report.docx", kind: "file", size: 12, modifiedAt: MODIFIED };

  it("accepts a listing and defaults the truncation flag", () => {
    const parsed = AppFileListReplySchema.parse({ entries: [entry, { ...entry, name: "Old", path: "Documents/Old", kind: "dir", size: 0 }] });
    expect(parsed.truncated).toBe(false);
    expect(parsed.entries).toHaveLength(2);
    expect(AppFileListReplySchema.parse({ entries: [], truncated: true }).truncated).toBe(true);
  });

  it("rejects malformed entries and listings above 500 entries", () => {
    expect(AppFileListReplySchema.safeParse({ entries: [{ ...entry, kind: "symlink" }] }).success).toBe(false);
    expect(AppFileListReplySchema.safeParse({ entries: [{ ...entry, name: "a/b" }] }).success).toBe(false);
    expect(AppFileListReplySchema.safeParse({ entries: [{ ...entry, path: "/abs/report.docx" }] }).success).toBe(false);
    expect(AppFileListReplySchema.safeParse({ entries: [{ ...entry, size: -1 }] }).success).toBe(false);
    expect(AppFileListReplySchema.safeParse({ entries: [{ ...entry, modifiedAt: "yesterday" }] }).success).toBe(false);
    expect(AppFileListReplySchema.safeParse({ entries: [{ ...entry, owner: "root" }] }).success).toBe(false);
    expect(AppFileListReplySchema.safeParse({ entries: Array.from({ length: 501 }, () => entry) }).success).toBe(false);
    expect(AppFileListReplySchema.safeParse({ entries: Array.from({ length: 500 }, () => entry) }).success).toBe(true);
  });

  it("accepts stat, read, write and mkdir replies", () => {
    expect(AppFileStatReplySchema.safeParse({ path: "a.docx", size: 12, modifiedAt: MODIFIED, version: VERSION }).success).toBe(true);
    // A stat may describe a file too large to read, so the app can explain why.
    expect(AppFileStatReplySchema.safeParse({ path: "big.xlsx", size: 5 * APP_FILE_MAX_BYTES, modifiedAt: MODIFIED, version: VERSION }).success).toBe(true);
    expect(AppFileReadReplySchema.safeParse({ path: "a.csv", contentBase64: "aGk=", size: 2, version: VERSION, mimeType: "text/csv" }).success).toBe(true);
    expect(AppFileWriteReplySchema.safeParse({ path: "a.docx", version: VERSION, size: 12, modifiedAt: MODIFIED }).success).toBe(true);
    expect(AppFileMkdirReplySchema.safeParse({ path: "Documents/New" }).success).toBe(true);
  });

  it("rejects a read reply whose size disagrees with its content", () => {
    expect(AppFileReadReplySchema.safeParse({ path: "a.csv", contentBase64: "aGk=", size: 3, version: VERSION, mimeType: "text/csv" }).success).toBe(false);
    expect(AppFileReadReplySchema.safeParse({ path: "a.csv", contentBase64: "aGk", size: 2, version: VERSION, mimeType: "text/csv" }).success).toBe(false);
    expect(AppFileReadReplySchema.safeParse({ path: "a.csv", contentBase64: "aGk=", size: 2, version: VERSION, mimeType: "csv" }).success).toBe(false);
    expect(AppFileWriteReplySchema.safeParse({ path: "a.docx", version: VERSION, size: APP_FILE_MAX_BYTES + 1, modifiedAt: MODIFIED }).success).toBe(false);
  });
});

describe("app file versions", () => {
  it("derives a stable opaque token from size and modification time", () => {
    expect(appFileVersion(12, 1_700_000_000_123_456_789n)).toBe(VERSION);
    expect(appFileVersion(12n, 1_700_000_000_123_456_789n)).toBe(VERSION);
    expect(AppFileVersionSchema.safeParse(VERSION).success).toBe(true);
    expect(VERSION.length).toBeLessThanOrEqual(128);
  });

  it("changes when the size or the modification time changes", () => {
    expect(appFileVersion(13, 1_700_000_000_123_456_789n)).not.toBe(VERSION);
    expect(appFileVersion(12, 1_700_000_000_123_456_790n)).not.toBe(VERSION);
    // Size and time must not be confusable with each other.
    expect(appFileVersion(1, 23n)).not.toBe(appFileVersion(12, 3n));
  });

  it("refuses values that cannot describe a file", () => {
    expect(() => appFileVersion(-1, 0n)).toThrow();
    expect(() => appFileVersion(1.5, 0n)).toThrow();
    expect(() => appFileVersion(1, -1n)).toThrow();
  });
});

describe("app file errors", () => {
  it("maps every code to one status and one generic message", () => {
    expect([...APP_FILE_ERROR_CODES].sort()).toEqual(["forbidden", "invalid_request", "not_found", "too_large", "unavailable", "version_conflict"]);
    expect(APP_FILE_ERROR_STATUS).toEqual({ not_found: 404, forbidden: 403, too_large: 413, version_conflict: 409, invalid_request: 400, unavailable: 503 });
    for (const code of APP_FILE_ERROR_CODES) {
      const body = appFileErrorBody(code);
      expect(body).toEqual({ error: { code, message: APP_FILE_ERROR_MESSAGES[code] } });
      expect(AppFileErrorBodySchema.safeParse(body).success).toBe(true);
      expect(appFileErrorCodeForStatus(APP_FILE_ERROR_STATUS[code])).toBe(code);
      // Generic copy only: no paths, system names or stack fragments.
      expect(APP_FILE_ERROR_MESSAGES[code]).not.toMatch(/[/\\]|ENOENT|EACCES|errno|stack/i);
    }
  });

  it("treats unknown statuses as unavailable", () => {
    for (const status of [0, 200, 401, 429, 500, 502, 504]) expect(appFileErrorCodeForStatus(status)).toBe("unavailable");
  });

  it("rejects error bodies with unknown codes or extra detail", () => {
    expect(AppFileErrorBodySchema.safeParse({ error: { code: "eacces", message: "x" } }).success).toBe(false);
    expect(AppFileErrorBodySchema.safeParse({ error: { code: "forbidden", message: "x", path: "/home/matrix/home/system" } }).success).toBe(false);
    expect(AppFileErrorBodySchema.safeParse({ error: "forbidden" }).success).toBe(false);
  });

  it("carries the code on a recognisable error", () => {
    const error = new BridgeFileError("version_conflict");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BridgeFileError");
    expect(error.code).toBe("version_conflict");
    expect(error.message).toBe(APP_FILE_ERROR_MESSAGES.version_conflict);
    expect(isBridgeFileError(error)).toBe(true);
    // Errors raised by the injected bridge script are plain objects from another realm.
    expect(isBridgeFileError({ name: "BridgeFileError", code: "not_found", message: "File not found" })).toBe(true);
    expect(isBridgeFileError(new Error("File not found"))).toBe(false);
    expect(isBridgeFileError({ name: "BridgeFileError", code: "enoent" })).toBe(false);
    expect(isBridgeFileError(null)).toBe(false);
  });
});

describe("app file base64 codec", () => {
  it("round-trips every byte value at every padding length", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    for (const length of [0, 1, 2, 3, 4, 5, 255, 256]) {
      const bytes = all.subarray(0, length);
      const text = encodeAppFileBase64(bytes);
      expect(appFileBase64ByteLength(text)).toBe(length);
      expect(Array.from(decodeAppFileBase64(text))).toEqual(Array.from(bytes));
    }
    expect(encodeAppFileBase64(new TextEncoder().encode("hi"))).toBe("aGk=");
  });

  it("round-trips content that spans internal chunk boundaries", () => {
    const bytes = new Uint8Array(200_003);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 7) & 0xff;
    const decoded = decodeAppFileBase64(encodeAppFileBase64(bytes));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.every((value, index) => value === bytes[index])).toBe(true);
  });

  it("refuses to decode text that is not canonical base64", () => {
    expect(() => decodeAppFileBase64("aGk")).toThrow();
    expect(() => decodeAppFileBase64("a b=")).toThrow();
  });
});

describe("app files client", () => {
  function hostReturning(reply: unknown) {
    const calls: AppFileInput[] = [];
    const client = createAppFilesClient(async (input) => { calls.push(input); return reply; });
    return { calls, client };
  }

  it("reads a file as bytes", async () => {
    const { calls, client } = hostReturning({ path: "a.csv", contentBase64: "aGk=", size: 2, version: VERSION, mimeType: "text/csv" });
    const file = await client.read("a.csv");
    expect(calls).toEqual([{ kind: "files.read", path: "a.csv" }]);
    expect(file).toEqual({ path: "a.csv", bytes: new TextEncoder().encode("hi"), size: 2, version: VERSION, mimeType: "text/csv" });
    expect(file.bytes).toBeInstanceOf(Uint8Array);
  });

  it("writes bytes with the caller's precondition", async () => {
    const { calls, client } = hostReturning({ path: "a.csv", version: VERSION, size: 2, modifiedAt: MODIFIED });
    const written = await client.write("a.csv", new TextEncoder().encode("hi"), { ifVersion: null, createParents: true });
    expect(calls).toEqual([{ kind: "files.write", path: "a.csv", contentBase64: "aGk=", ifVersion: null, createParents: true }]);
    expect(written).toEqual({ path: "a.csv", version: VERSION, size: 2, modifiedAt: MODIFIED });
    await client.write("a.csv", new Uint8Array(), { ifVersion: VERSION });
    expect(calls[1]).toEqual({ kind: "files.write", path: "a.csv", contentBase64: "", ifVersion: VERSION });
  });

  it("lists, stats and creates directories", async () => {
    const entry = { name: "a.csv", path: "a.csv", kind: "file", size: 2, modifiedAt: MODIFIED };
    const list = hostReturning({ entries: [entry] });
    expect(await list.client.list("")).toEqual({ entries: [entry], truncated: false });
    expect(await list.client.list("Documents", { limit: 10 })).toEqual({ entries: [entry], truncated: false });
    expect(list.calls).toEqual([{ kind: "files.list", dir: "", limit: 500 }, { kind: "files.list", dir: "Documents", limit: 10 }]);
    const stat = hostReturning({ path: "a.csv", size: 2, modifiedAt: MODIFIED, version: VERSION });
    expect(await stat.client.stat("a.csv")).toEqual({ path: "a.csv", size: 2, modifiedAt: MODIFIED, version: VERSION });
    const mkdir = hostReturning({ path: "Documents/New" });
    expect(await mkdir.client.mkdir("Documents/New")).toEqual({ path: "Documents/New" });
    expect(mkdir.calls).toEqual([{ kind: "files.mkdir", path: "Documents/New" }]);
  });

  it("rejects invalid requests and oversized content before reaching the host", async () => {
    const { calls, client } = hostReturning({});
    await expect(client.read("../system/soul.md")).rejects.toMatchObject({ name: "BridgeFileError", code: "invalid_request" });
    await expect(client.list("Documents", { limit: 501 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.write("a.docx", new Uint8Array(APP_FILE_MAX_BYTES + 1), { ifVersion: null })).rejects.toMatchObject({ code: "too_large" });
    await expect(client.write("a.docx", "text" as unknown as Uint8Array, { ifVersion: null })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.write("a.docx", new Uint8Array(1), {} as { ifVersion: null })).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toEqual([]);
  });

  it.each(APP_FILE_ERROR_CODES)("surfaces a %s reply as a typed error with generic copy", async (code) => {
    const { client } = hostReturning({ error: { code, message: "Leaked detail: /home/matrix/home/system/soul.md" } });
    const failure = await client.read("a.docx").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BridgeFileError);
    expect(failure).toMatchObject({ code, message: APP_FILE_ERROR_MESSAGES[code] });
  });

  it("keeps a typed error thrown by the host and hides every other failure", async () => {
    const typed = createAppFilesClient(async () => { throw new BridgeFileError("version_conflict"); });
    await expect(typed.write("a.docx", new Uint8Array(1), { ifVersion: VERSION })).rejects.toMatchObject({ code: "version_conflict" });
    const leaky = createAppFilesClient(async () => { throw new Error("EACCES: /home/matrix/home/system"); });
    const failure = await leaky.read("a.docx").catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "BridgeFileError", code: "unavailable", message: APP_FILE_ERROR_MESSAGES.unavailable });
  });

  it("treats a malformed reply as unavailable", async () => {
    for (const reply of [null, {}, { path: "a.csv", contentBase64: "aGk=", size: 9, version: VERSION, mimeType: "text/csv" }, "text"]) {
      await expect(hostReturning(reply).client.read("a.csv")).rejects.toMatchObject({ code: "unavailable" });
    }
  });

  it("names the route and the manifest permission", () => {
    expect(APP_FILES_BRIDGE_PATH).toBe("/api/bridge/files");
    expect(APP_FILES_PERMISSION).toBe("files");
  });
});

describe("window.MatrixOS declaration for default apps", () => {
  const root = process.cwd();
  const declaration = readFileSync(join(root, "home/apps/_shared/matrix-os.d.ts"), "utf8");
  const bridge = readFileSync(join(root, "shell/src/lib/os-bridge.ts"), "utf8");

  function interfaceBody(name: string): string {
    const start = declaration.indexOf(`export interface ${name} {`);
    expect(start, `interface ${name}`).toBeGreaterThanOrEqual(0);
    return declaration.slice(start, declaration.indexOf("\n}\n", start));
  }
  function declaredMembers(name: string): string[] {
    return [...interfaceBody(name).matchAll(/^ {2}(\w+)[(<:?]/gm)].map((match) => match[1]!).sort();
  }
  /** Keys of an object literal in the injected script, found by their indentation. */
  function scriptKeys(opening: string, indent: number): string[] {
    const start = bridge.indexOf(opening);
    expect(start, opening).toBeGreaterThanOrEqual(0);
    const closing = new RegExp(`^\\t? {${indent - 2}}\\}`, "m");
    const body = bridge.slice(start + opening.length);
    const end = body.search(closing);
    return [...body.slice(0, end).matchAll(new RegExp(`^\\t? {${indent}}(\\w+):`, "gm"))].map((match) => match[1]!);
  }

  it("declares exactly the members the injected bridge provides, plus files", () => {
    const provided = scriptKeys("window.MatrixOS = {", 4);
    expect(provided).toContain("readData");
    expect(provided).toContain("collaboration");
    expect(declaredMembers("MatrixOSBridge")).toEqual([...new Set([...provided, "files"])].sort());
  });

  it("declares exactly the database methods the injected bridge provides", () => {
    const provided = scriptKeys("db: {", 6);
    expect(provided).toContain("compareAndSwap");
    expect(declaredMembers("MatrixOSDb")).toEqual([...provided].sort());
  });

  it("declares the files namespace of the contract client plus the open-request pair", () => {
    const client = createAppFilesClient(async () => ({}));
    expect(declaredMembers("MatrixOSFiles")).toEqual([...Object.keys(client), "onOpenRequest", "openRequest"].sort());
  });

  it("repeats the contract's error codes and reply fields", () => {
    const union = declaration.slice(declaration.indexOf("export type BridgeFileErrorCode ="), declaration.indexOf(";", declaration.indexOf("export type BridgeFileErrorCode =")));
    expect([...union.matchAll(/"(\w+)"/g)].map((match) => match[1]).sort()).toEqual([...APP_FILE_ERROR_CODES].sort());
    expect(declaredMembers("BridgeFileEntry")).toEqual(Object.keys(AppFileListReplySchema.shape.entries.element.shape).sort());
    expect(declaredMembers("BridgeFileListing")).toEqual(Object.keys(AppFileListReplySchema.shape).sort());
    expect(declaredMembers("BridgeFileStat")).toEqual(Object.keys(AppFileStatReplySchema.shape).sort());
    expect(declaredMembers("BridgeFileWriteResult")).toEqual(Object.keys(AppFileWriteReplySchema.shape).sort());
    expect(declaredMembers("BridgeFileWriteOptions")).toEqual(["createParents", "ifVersion"]);
    // The app sees decoded bytes where the wire carries base64.
    expect(declaredMembers("BridgeFileContent")).toEqual(["bytes", "mimeType", "path", "size", "version"]);
  });
});
