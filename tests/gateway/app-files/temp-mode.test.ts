import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appFileVersion, encodeAppFileBase64 } from "../../../packages/contracts/src/app-files";
import { APP_FILE_TEMP_PREFIX } from "../../../packages/gateway/src/app-files/write-ops";
import { createHarness, type AppFileHarness } from "./helpers";

/** Permission bits of each app file temp copy right after its bytes were written. */
const probe = vi.hoisted(() => ({ tempModesAfterWrite: [] as number[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (!basename(String(args[0])).startsWith(APP_FILE_TEMP_PREFIX)) return handle;
    const writeFile = handle.writeFile.bind(handle);
    handle.writeFile = (async (...writeArgs: Parameters<typeof handle.writeFile>) => {
      await writeFile(...writeArgs);
      probe.tempModesAfterWrite.push(Number((await handle.stat()).mode) & 0o777);
    }) as typeof handle.writeFile;
    return handle;
  }) as typeof actual.open;
  const fs = { ...actual, open };
  return { ...fs, default: fs };
});

let harness: AppFileHarness | null = null;
afterEach(async () => {
  probe.tempModesAfterWrite = [];
  await harness?.cleanup();
  harness = null;
});

async function versionOf(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return appFileVersion(info.size, info.mtimeNs);
}

// Fault detected: saving a private document leaves a group- or world-readable
// copy of its new content on disk until the replace publishes.
describe("files.write replacing a private file", () => {
  it.each([
    { label: "0600", mode: 0o600 },
    { label: "0640", mode: 0o640 },
  ])("never holds the new content in a temp copy readable beyond the owner (target $label)", async ({ mode }) => {
    harness = await createHarness();
    const target = join(harness.home, "private.docx");
    await writeFile(target, "old");
    await chmod(target, mode);
    const response = await harness.post({
      kind: "files.write", path: "private.docx",
      contentBase64: encodeAppFileBase64(new TextEncoder().encode("secret")), ifVersion: await versionOf(target),
    });
    expect(response.status).toBe(200);
    expect(probe.tempModesAfterWrite).toHaveLength(1);
    expect(probe.tempModesAfterWrite[0]! & 0o077).toBe(0);
    expect(await readFile(target, "utf8")).toBe("secret");
    expect((await stat(target)).mode & 0o777).toBe(mode);
  });
});
