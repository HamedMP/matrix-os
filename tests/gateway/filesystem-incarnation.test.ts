import { describe, expect, it, vi } from "vitest";
import { createFilesystemIncarnation } from "../../packages/gateway/src/collaboration/filesystem-incarnation.js";

function response(generation: number) {
  const bytes = Buffer.alloc(40);
  bytes.write("MFI2");
  bytes.writeUInt32BE(0xef53, 4);
  bytes.writeUInt32BE(1, 8); // Persistent filesystem identifier, not mount ID.
  bytes.writeUInt32BE(1, 24);
  bytes.writeUInt32BE(8, 28);
  bytes.writeUInt32BE(123, 32); // Same inode and exposed stat tuple.
  bytes.writeUInt32BE(generation, 36);
  return bytes;
}
describe("descriptor-bound filesystem incarnations", () => {
  it("distinguishes generations when every exposed stat field collides", () => {
    let current = response(1);
    const identity = createFilesystemIncarnation((fd) => { expect(fd).toBe(7); return current; });
    const original = identity(7);
    current = response(2);
    expect(identity(7)).not.toBe(original);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([undefined, "123", Buffer.alloc(0), Buffer.alloc(32), response(1).subarray(0, 31), Buffer.concat([response(1), Buffer.alloc(1)])])("rejects malformed native responses without a metadata fallback (%s)", (invalid) => {
    expect(() => createFilesystemIncarnation(() => invalid)(7)).toThrowError(expect.objectContaining({ code: "unavailable" }));
  });

  it("fails closed on native errors and invalid descriptors", () => {
    expect(() => createFilesystemIncarnation(() => { throw new Error("unsupported"); })(7)).toThrowError(expect.objectContaining({ code: "unavailable" }));
    const readIdentity = vi.fn(() => { throw new Error("Native provider must not be called for invalid descriptors"); });
    const identity = createFilesystemIncarnation(readIdentity);
    for (const fd of [-1, 1.5, Number.NaN, 2 ** 32]) expect(() => identity(fd)).toThrowError(expect.objectContaining({ code: "unavailable" }));
    expect(readIdentity).not.toHaveBeenCalled();
  });

  it("rejects unsupported filesystem, empty fsid and invalid handle metadata", () => {
    for (const offset of [4, 8, 24, 28]) {
      const bytes = response(1); bytes.writeUInt32BE(0, offset);
      expect(() => createFilesystemIncarnation(() => bytes)(7)).toThrowError(expect.objectContaining({ code: "unavailable" }));
    }
  });

});
