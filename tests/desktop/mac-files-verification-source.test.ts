import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveFilesTrashLabel, verifiedFilesTrashSource } from "../../desktop/src/main/chat-electron-preview/files-source";

const base = Buffer.from('const item = { label: "Move to Trash", onSelect: () => trash(entry) };\n');
const changed = Buffer.from(base.toString().replace("Move to Trash", "Send to Trash"));
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

describe("Mac Files verification source", () => {
  it("admits the trusted Files menu or an exact display copy change", () => {
    expect(deriveFilesTrashLabel(base, base)).toBe("Move to Trash");
    expect(deriveFilesTrashLabel(base, changed)).toBe("Send to Trash");
    expect(verifiedFilesTrashSource(base, "Send to Trash", digest(changed))).toEqual(changed);
  });

  it("rejects executable changes, ambiguous matches and the wrong digest", () => {
    expect(deriveFilesTrashLabel(base, Buffer.concat([changed, Buffer.from('run()')]))).toBeNull();
    expect(deriveFilesTrashLabel(base, Buffer.from('label: "a", exec(), //",'))).toBeNull();
    expect(deriveFilesTrashLabel(Buffer.concat([base, base]), base)).toBeNull();
    expect(() => verifiedFilesTrashSource(base, "Send to Trash", digest(base))).toThrow("checksum");
  });
});
