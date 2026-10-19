import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedPiSystemPrompt, MANAGED_PI_SOUL_MAX_BYTES, MANAGED_PI_BASE_PROMPT } from "../../../packages/gateway/src/chat/managed-pi-system-prompt.js";

// Fault injection surrounds real temporary files and handles. It does not
// replace the SOUL reader or its prompt/resource checks.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat), realpath: vi.fn(actual.realpath) };
});
let home: string;
let system: string;
let soul: string;
const handles: fs.FileHandle[] = [];
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const input = { owner: { type: "personal" as const, ownerId: "user_owner" } };
const load = () => createManagedPiSystemPrompt({ homePath: home, runtimeOwnerId: "user_owner" })(input);

beforeEach(async () => {
  vi.mocked(fs.open).mockReset().mockImplementation(async (...args) => {
    const handle = await actual.open(...args); handles.push(handle); return handle;
  });
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat);
  vi.mocked(fs.realpath).mockReset().mockImplementation(actual.realpath);
  home = await fs.mkdtemp(join(tmpdir(), "pi-soul-fault-"));
  system = join(await actual.realpath(home), "system");
  await fs.mkdir(system);
  soul = join(system, "soul.md");
  await fs.writeFile(soul, "Your name is Juniper.");
});
afterEach(async () => {
  vi.restoreAllMocks();
  // A test failure must still close native resources, including injected faults.
  await Promise.all(handles.splice(0).map(handle => handle.close()));
  await fs.rm(home, { recursive: true, force: true });
});

it("closes the parent descriptor even when closing the file reports a failure", async () => {
  let directoryClose: ReturnType<typeof vi.spyOn> | undefined;
  let fileClose: ReturnType<typeof vi.spyOn> | undefined;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args); handles.push(handle);
    if (args[0] === system) directoryClose = vi.spyOn(handle, "close");
    else {
      const close = handle.close.bind(handle);
      fileClose = vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        throw Object.assign(new Error("PRIVATE_CLOSE_DIAGNOSTIC"), { code: "EIO" });
      });
    }
    return handle;
  });
  await expect(load()).rejects.toMatchObject({ code: "unreadable", message: "Matrix personality unavailable" });
  expect(fileClose).toHaveBeenCalledOnce();
  expect(directoryClose).toHaveBeenCalledOnce();
});

it("rejects an actual parent directory replacement between lstat and open, then closes the new descriptor", async () => {
  let close: ReturnType<typeof vi.spyOn> | undefined;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (args[0] === system) {
      await fs.rename(system, join(home, "old-system"));
      await fs.mkdir(system);
      await fs.writeFile(soul, "REPLACEMENT_CANARY");
    }
    const handle = await actual.open(...args); handles.push(handle);
    close = vi.spyOn(handle, "close");
    return handle;
  });
  await expect(load()).rejects.toMatchObject({ code: "unsafe_file" });
  expect(fs.open).toHaveBeenCalledOnce(); // Refused before opening or reading SOUL.
  expect(close).toHaveBeenCalledOnce();
});

it("rejects an actual file substitution between lstat and open and closes both descriptors", async () => {
  const closes: Array<ReturnType<typeof vi.spyOn>> = [];
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (args[0] !== system) {
      await fs.rename(soul, join(system, "old-soul.md"));
      await fs.writeFile(soul, "REPLACEMENT_CANARY");
    }
    const handle = await actual.open(...args); handles.push(handle);
    closes.push(vi.spyOn(handle, "close"));
    return handle;
  });
  await expect(load()).rejects.toMatchObject({ code: "unsafe_file" });
  expect(closes).toHaveLength(2);
  for (const close of closes) expect(close).toHaveBeenCalledOnce();
});

it("rejects real file growth between the initial path stat and opened-handle stat without reading bytes", async () => {
  let read: ReturnType<typeof vi.spyOn> | undefined;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (args[0] !== system) await fs.appendFile(soul, "x".repeat(MANAGED_PI_SOUL_MAX_BYTES));
    const handle = await actual.open(...args); handles.push(handle);
    if (args[0] !== system) read = vi.spyOn(handle, "read");
    return handle;
  });
  await expect(load()).rejects.toMatchObject({ code: "too_large" });
  expect(read).not.toHaveBeenCalled();
});

it("detects real growth during the bounded read, rather than accepting a truncated personality", async () => {
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args); handles.push(handle);
    if (args[0] !== system) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs: Parameters<typeof handle.read>) => {
        await fs.appendFile(soul, "x".repeat(MANAGED_PI_SOUL_MAX_BYTES));
        return read(...readArgs);
      });
    }
    return handle;
  });
  await expect(load()).rejects.toMatchObject({ code: "too_large" });
});

it.each(["ELOOP", "ENOTDIR"])("classifies an OS %s rejection without exposing its path or message", async code => {
  vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error("PRIVATE_PATH_CANARY"), { code }));
  await expect(load()).rejects.toMatchObject({ code: "unsafe_file", message: "Matrix personality unavailable" });
});

it.each([new Error("PRIVATE_DIAGNOSTIC"), { code: "PRIVATE_CODE" }])("fails safely for unexpected filesystem failures", async error => {
  vi.mocked(fs.lstat).mockRejectedValueOnce(error);
  await expect(load()).rejects.toMatchObject({ code: "unreadable", message: "Matrix personality unavailable" });
});

it("treats a missing configured owner home as unavailable, while a missing system directory keeps defaults", async () => {
  await fs.rm(system, { recursive: true, force: true });
  expect(await load()).toBe(MANAGED_PI_BASE_PROMPT);
  await fs.rm(home, { recursive: true, force: true });
  await expect(load()).rejects.toMatchObject({ code: "unreadable" });
});

it("synthetically exercises Linux descriptor-relative lookup using mapped host filesystem handles", async () => {
  // This verifies path selection and flags; it is not evidence of actual Linux
  // /proc semantics. Preview VPS acceptance independently tests the native path.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const mapped = (path: Parameters<typeof actual.open>[0]) => typeof path === "string" && /^\/proc\/self\/fd\/\d+\/soul\.md$/.test(path) ? soul : path;
  const paths: unknown[] = [];
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    paths.push(args[0]);
    const handle = await actual.open(mapped(args[0]), args[1], args[2]); handles.push(handle); return handle;
  });
  vi.mocked(fs.lstat).mockImplementation((path, options) => actual.lstat(mapped(path), options) as never);
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    expect(await load()).toContain("Your name is Juniper.");
    expect(paths[1]).toMatch(/^\/proc\/self\/fd\/\d+\/soul\.md$/);
    expect(fs.open).toHaveBeenLastCalledWith(paths[1], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } finally { Object.defineProperty(process, "platform", platform); }
});
