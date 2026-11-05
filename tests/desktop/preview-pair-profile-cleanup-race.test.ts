import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createPreviewPairProfile, removePreviewPairProfile } from "@desktop/main/preview-pair-profiles";
import { claimPreviewProfile } from "@desktop/main/preview-pair-profile-lease";
import { verifiedPreviewPairTestContext } from "./preview-pair-test-context.js";

const deletion = vi.hoisted(() => ({ generation: "", enter: undefined as (() => void) | undefined,
  resume: Promise.resolve() }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, async rm(path: Parameters<typeof actual.rm>[0], options: Parameters<typeof actual.rm>[1]) {
    if (deletion.enter && options?.recursive && String(path).startsWith(deletion.generation + sep)) {
      const entered = deletion.enter; deletion.enter = undefined;
      // Reproduce a real recursive delete's non-atomic removal of the active
      // lease while the rest of the profile still exists. All I/O stays real.
      await actual.unlink(join(String(path), ".preview-active.json")); entered();
      await deletion.resume;
    }
    return actual.rm(path, options);
  } };
});

it("cannot claim a profile being deleted, and a fresh replacement survives the old cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "eng418-cleanup-race-"));
  let unblock!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  deletion.resume = new Promise<void>(resolve => { unblock = resolve; });
  let raced: Awaited<ReturnType<typeof claimPreviewProfile>> | undefined;
  let replacement: Awaited<ReturnType<typeof claimPreviewProfile>> | undefined;
  let finished: Promise<unknown> | undefined;
  try {
    const owner = await verifiedPreviewPairTestContext(), member = await verifiedPreviewPairTestContext("member");
    const paths = await createPreviewPairProfile(owner, home), peer = await createPreviewPairProfile(member, home);
    const normal = join(home, "normal"); await mkdir(normal); await writeFile(join(normal, "keep"), "normal-state");
    await writeFile(join(peer.userData, "keep"), "member-state");
    deletion.generation = dirname(paths.root); deletion.enter = entered;
    finished = removePreviewPairProfile(owner.pairId, owner.generation, "owner", home)
      .then(() => ({ ok: true }), error => ({ ok: false, error }));
    await paused;
    const [claim] = await Promise.allSettled([claimPreviewProfile(paths.root)]);
    if (claim.status === "fulfilled") raced = claim.value;
    expect(claim.status).toBe("rejected");
    const fresh = await createPreviewPairProfile(owner, home);
    replacement = await claimPreviewProfile(fresh.root);
    await writeFile(join(fresh.userData, "keep"), "new-state");
    unblock(); expect(await finished).toMatchObject({ ok: true });
    expect(await readFile(join(fresh.userData, "keep"), "utf8")).toBe("new-state");
    await expect(claimPreviewProfile(fresh.root)).rejects.toThrow();
    expect(await readFile(join(peer.userData, "keep"), "utf8")).toBe("member-state");
    expect(await readFile(join(normal, "keep"), "utf8")).toBe("normal-state");
  } finally {
    await raced?.release(); await replacement?.release(); unblock(); await finished;
    deletion.enter = undefined;
    await rm(home, { recursive: true, force: true });
  }
});
