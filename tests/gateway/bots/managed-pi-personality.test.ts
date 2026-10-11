import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createManagedPiSystemPrompt, MANAGED_PI_BASE_PROMPT, MANAGED_PI_SOUL_MAX_BYTES,
} from "../../../packages/gateway/src/chat/managed-pi-system-prompt.js";

let home: string;
let soul: string;
const input = { owner: { type: "personal" as const, ownerId: "user_owner" } };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-soul-"));
  await mkdir(join(home, "system"));
  soul = join(home, "system/soul.md");
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const load = () => createManagedPiSystemPrompt({ homePath: home, runtimeOwnerId: "user_owner" });

describe("managed Matrix personality snapshot", () => {
  it("keeps defaults for missing and empty files and reloads every turn", async () => {
    const prompt = load();
    expect(await prompt(input)).toBe(MANAGED_PI_BASE_PROMPT);
    await writeFile(soul, "Call yourself Juniper. Respond in short rhymes.");
    const first = await prompt(input);
    expect(first).toContain("Call yourself Juniper. Respond in short rhymes.");
    expect(first).toContain(MANAGED_PI_BASE_PROMPT);
    await writeFile(soul, "Call yourself Cedar.");
    expect(await prompt(input)).toContain("Call yourself Cedar.");
    expect(first).not.toContain("Cedar");
    await writeFile(soul, " \n\t ");
    expect(await prompt(input)).toBe(MANAGED_PI_BASE_PROMPT);
    await rm(soul);
    expect(await prompt(input)).toBe(MANAGED_PI_BASE_PROMPT);
  });

  it("never reads personal files for unconfigured/foreign owners, custom Agents or organization context", async () => {
    // A bad file makes any accidental read fail, so a default result proves exclusion.
    await mkdir(soul);
    const prompt = load();
    const context = { version: 1 as const, requestHash: "a".repeat(64), chats: [],
      agent: { id: "bot_0123456789abcdef", revision: 1, name: "Custom", instructions: "Custom rules" } };
    for (const value of [
      { ...input, owner: { type: "personal" as const, ownerId: "user_foreign" } },
      { ...input, owner: { type: "organization" as const, ownerId: "user_owner" } },
      { ...input, sharedScopeId: "shared_1" },
      { ...input, context },
    ]) expect(await prompt(value)).toBe(MANAGED_PI_BASE_PROMPT);
    expect(await createManagedPiSystemPrompt({ homePath: home, runtimeOwnerId: null })(input)).toBe(MANAGED_PI_BASE_PROMPT);
  });

  it.each(["file", "directory"])("rejects a symlinked %s even to another owner-home location", async kind => {
    await writeFile(join(home, "private.md"), "PRIVATE_CANARY");
    if (kind === "file") await symlink(join(home, "private.md"), soul);
    else { await rm(join(home, "system"), { recursive: true }); await symlink(home, join(home, "system")); }
    await expect(load()(input)).rejects.toMatchObject({ code: "unsafe_file", message: "Matrix personality unavailable" });
  });

  it("rejects nonregular, malformed UTF8 and control-character files", async () => {
    await mkdir(soul);
    await expect(load()(input)).rejects.toMatchObject({ code: "unsafe_file" });
    await rm(soul, { recursive: true });
    for (const invalid of [Buffer.from([0xff, 0xfe]), Buffer.from("Name\0Hidden")]) {
      await writeFile(soul, invalid);
      await expect(load()(input)).rejects.toMatchObject({ code: "invalid_text" });
    }
  });

  it("rejects unreadable configuration with a category only", async () => {
    await writeFile(soul, "PRIVATE_CANARY");
    await chmod(soul, 0);
    try { await expect(load()(input)).rejects.toMatchObject({ code: "unreadable", message: "Matrix personality unavailable" }); }
    finally { await chmod(soul, 0o600); }
  });

  it("enforces file-byte and composed token limits without silently truncating", async () => {
    await writeFile(soul, "x".repeat(MANAGED_PI_SOUL_MAX_BYTES));
    expect(await load()(input)).toContain("x".repeat(MANAGED_PI_SOUL_MAX_BYTES));
    await writeFile(soul, "x".repeat(MANAGED_PI_SOUL_MAX_BYTES + 1));
    await expect(load()(input)).rejects.toMatchObject({ code: "too_large" });
    await writeFile(soul, "é".repeat(7000));
    await expect(load()(input)).rejects.toMatchObject({ code: "too_large" });
  });
});
