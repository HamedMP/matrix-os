import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { claimPreviewProfile } from "@desktop/main/preview-pair-profile-lease";
it("prevents concurrent cleanup/startup while the owning process is alive and releases only its own lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "eng418-profile-lease-"));
  try {
    const first = await claimPreviewProfile(root);
    await expect(claimPreviewProfile(root)).rejects.toThrow("in use");
    await first.release(); const next = await claimPreviewProfile(root); await next.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refuses malformed or untrusted activity files instead of assuming a stopped app", async () => {
  const root = await mkdtemp(join(tmpdir(), "eng418-profile-lease-"));
  try {
    await writeFile(join(root, ".preview-active.json"), "invalid", { mode: 0o600 });
    await expect(claimPreviewProfile(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
