import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_GET_STARTED_BOT } from "../../packages/contracts/src/index.js";

// Replaces the owner's system directory right after the profile is read, before it is written.
const swap = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock("../../packages/gateway/src/get-started/owner-system-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/get-started/owner-system-dir.js")>();
  return {
    ...actual,
    withPinnedSystemDir: (homePath: string, use: (dir: import("../../packages/gateway/src/get-started/owner-system-dir.js").PinnedSystemDir) => Promise<unknown>) =>
      actual.withPinnedSystemDir(homePath, (dir) => use({
        ...dir,
        async readFile(name, maxBytes) {
          const text = await dir.readFile(name, maxBytes);
          if (name === "identity.md" && swap.run) await swap.run();
          return text;
        },
      })),
  };
});

const { applyGetStartedPersonality } = await import("../../packages/gateway/src/get-started/personality.js");

const IDENTITY = "# Identity\n\n- **Name:** Matrix OS\n- **Vibe:** Direct, curious, proactive\n";

describe("get started profile writes", () => {
  let root: string;
  let homePath: string;

  beforeEach(async () => {
    root = resolve(await mkdtemp(join(tmpdir(), "get-started-profile-")));
    homePath = join(root, "home");
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system", "soul.md"), "# Soul\n");
    await writeFile(join(homePath, "system", "identity.md"), IDENTITY);
  });

  afterEach(async () => {
    swap.run = null;
    await rm(root, { recursive: true, force: true });
  });

  it("never commits a profile into a directory that replaced the validated one", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    swap.run = async () => {
      await rename(join(homePath, "system"), join(homePath, "system-moved"));
      await symlink(outside, join(homePath, "system"));
    };
    await expect(applyGetStartedPersonality(homePath, { goals: [], tools: [], bot: { ...DEFAULT_GET_STARTED_BOT, name: "Atlas" } })).rejects.toThrow();
    expect(existsSync(join(outside, "identity.md"))).toBe(false);
    expect(await readFile(join(homePath, "system-moved", "identity.md"), "utf-8")).toBe(IDENTITY);
  });
});
