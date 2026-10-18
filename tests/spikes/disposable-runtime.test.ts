import { describe, expect, it, vi } from "vitest";
import { DockerFixture, prepareCheckpointRoot, runCycle, verifyBackup, verifyMutationState } from "../../scripts/spikes/disposable-runtime/benchmark.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const acknowledged = { owner: "synthetic-a", revision: 1, fileHash: "file", rows: "rows" };
function adapter() {
  return {
    seed: vi.fn(async () => acknowledged),
    checkpoint: vi.fn(async () => ({ owner: acknowledged.owner })),
    validate: vi.fn(async () => undefined),
    destroy: vi.fn(async () => ({ containersDeleted: true, volumesDeleted: true })),
    restore: vi.fn(async () => undefined),
    read: vi.fn(async () => acknowledged),
    mutate: vi.fn(async () => ({ ...acknowledged, revision: 2, rows: "mutated-rows" })),
    cleanup: vi.fn(async () => undefined),
  };
}

describe("disposable runtime lifecycle", () => {
  it("applies the same post-wake write checks to every restore mode", () => {
    const mutated = { ...acknowledged, revision: 2, rows: "mutated-rows" };
    expect(() => verifyMutationState(acknowledged, mutated)).not.toThrow();
    for (const invalid of [
      { ...mutated, owner: "synthetic-other" },
      { ...mutated, fileHash: "unexpected-file" },
      { ...mutated, revision: acknowledged.revision },
      { ...mutated, rows: acknowledged.rows },
    ]) expect(() => verifyMutationState(acknowledged, invalid)).toThrow();
  });
  it("creates a new explicit parent for normal cycles without precreating a save-only checkpoint", async () => {
    const parent = await mkdtemp(join(tmpdir(), "matrix-checkpoint-root-test-"));
    try {
      const normal = join(parent, "normal");
      expect(await prepareCheckpointRoot({ "--checkpoint-root": normal })).toBe(normal);
      expect((await stat(normal)).isDirectory()).toBe(true);
      await expect(prepareCheckpointRoot({ "--checkpoint-root": normal })).rejects.toThrow();
      const saved = join(parent, "save-only");
      expect(await prepareCheckpointRoot({ "--checkpoint-root": saved, "--save-only": true })).toBe(saved);
      await expect(stat(saved)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it("validates an independent checkpoint before destroying and checks restored acknowledged state", async () => {
    const a = adapter();
    const result = await runCycle(a);
    expect(result.restored).toEqual(acknowledged);
    expect(result.mutated.revision).toBe(2);
    expect(a.validate.mock.invocationCallOrder[0]).toBeLessThan(a.destroy.mock.invocationCallOrder[0]);
    expect(a.destroy.mock.invocationCallOrder[0]).toBeLessThan(a.restore.mock.invocationCallOrder[0]);
    expect(a.cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves live resources when checkpoint validation fails", async () => {
    const a = adapter();
    a.validate.mockRejectedValue(new Error("corrupt checkpoint"));
    await expect(runCycle(a)).rejects.toThrow("corrupt checkpoint");
    expect(a.destroy).not.toHaveBeenCalled();
    expect(a.restore).not.toHaveBeenCalled();
    expect(a.cleanup).not.toHaveBeenCalled();
  });

  it("fails closed on owner mismatch", async () => {
    const a = adapter();
    a.checkpoint.mockResolvedValue({ owner: "synthetic-other" });
    await expect(runCycle(a)).rejects.toThrow("owner mismatch");
    expect(a.destroy).not.toHaveBeenCalled();
    expect(a.cleanup).not.toHaveBeenCalled();
  });

  it("does not restore until deletion of both writable volumes is confirmed", async () => {
    const a = adapter();
    a.destroy.mockResolvedValue({ containersDeleted: true, volumesDeleted: false });
    await expect(runCycle(a)).rejects.toThrow("destruction incomplete");
    expect(a.restore).not.toHaveBeenCalled();
    expect(a.cleanup).not.toHaveBeenCalled();
  });

  it("preserves failed restored resources for inspection", async () => {
    const a = adapter();
    a.read.mockResolvedValue({ ...acknowledged, fileHash: "wrong" });
    await expect(runCycle(a)).rejects.toThrow("restored state mismatch");
    expect(a.mutate).not.toHaveBeenCalled();
    expect(a.cleanup).not.toHaveBeenCalled();
  });

  it("checks actual checkpoint bytes, not only a manifest assertion", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-spike-test-"));
    const bytes = Buffer.from("acknowledged data");
    const digest = createHash("sha256").update(bytes).digest("hex");
    try {
      await writeFile(join(root, "fixture.bin"), bytes);
      await writeFile(join(root, "database.sql"), bytes);
      const backup = { root, owner: acknowledged.owner, hashes: { "fixture.bin": digest, "database.sql": digest } };
      await expect(verifyBackup(backup, acknowledged.owner)).resolves.toBeUndefined();
      await expect(verifyBackup(backup, "other")).rejects.toThrow("owner mismatch");
      await writeFile(join(root, "fixture.bin"), "corrupt");
      await expect(verifyBackup(backup, acknowledged.owner)).rejects.toThrow("checkpoint checksum mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not allocate containers for an incomplete checkpoint", async () => {
    const fixture = new DockerFixture({ checkpointRoot: "/tmp/unused", owner: "synthetic-a" });
    const create = vi.spyOn(fixture, "create");
    await expect(fixture.restore({ owner: "synthetic-a", hashes: {} })).rejects.toThrow("checkpoint files incomplete");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to delete Docker resources with another ownership label", async () => {
    const fixture = new DockerFixture({ checkpointRoot: "/tmp/unused", owner: "synthetic-a" });
    fixture.names = [["container", "another-task"]];
    const docker = vi.spyOn(fixture, "docker").mockResolvedValue(JSON.stringify([{ Config: { Labels: { "matrix.spike": "someone-else" } } }]));
    await expect(fixture.cleanup()).rejects.toThrow("resource ownership mismatch");
    expect(docker).toHaveBeenCalledTimes(1);
    expect(docker).toHaveBeenCalledWith(["container", "inspect", "another-task"]);
  });
});
