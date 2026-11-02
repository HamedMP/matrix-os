import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodePreparation, decodePreparedReply, encodeBootstrap, encodeTarget, decodeBootstrapAck } from "../../packages/terminal-runtime/src/owned-root-wire.mjs";

const correlation = { deadlineNs: 123456789n, generation: Buffer.alloc(32, 0x11), nonce: Buffer.alloc(32, 0x22) };
const sessionName = "matrix-rt_0123456789abcdef0123456789abcdef";
const header = (magic: string, kind: number, body: Buffer) => {
  const head = Buffer.alloc(16); head.write(magic); head[8] = 1; head[9] = kind; head.writeUInt32LE(body.length, 12);
  return Buffer.concat([head, body]);
};
const short = (value: Buffer) => { const length = Buffer.alloc(2); length.writeUInt16LE(value.length); return Buffer.concat([length, value]); };
const prefix = () => { const value = Buffer.alloc(8); value.writeBigUInt64LE(correlation.deadlineNs); return Buffer.concat([value, correlation.generation, correlation.nonce]); };
function reply(entries: Array<[Buffer, Buffer]>, revision = 4n) {
  const count = Buffer.alloc(2); count.writeUInt16LE(entries.length);
  const environment = Buffer.concat([count, ...entries.flatMap(([key, value]) => [short(key), short(value)])]);
  const epoch = Buffer.alloc(8); epoch.writeBigUInt64LE(revision);
  return header("MXZPREP\0", 2, Buffer.concat([prefix(), epoch, environment,
    createHash("sha256").update("matrix-private-env-v1\0").update(environment).digest()]));
}

describe("keeper-local Root wire data only", () => {
  it("uses exact independently built stock config/bootstrap/target bytes under original correlation", () => {
    const layoutPath = "/owned/雪.kdl", socketPath = "/tmp/owned.sock";
    expect(encodePreparation({ ...correlation, sessionName, layoutPath })).toEqual(header("MXZPREP\0", 1,
      Buffer.concat([prefix(), short(Buffer.from(sessionName)), short(Buffer.from(layoutPath))])));
    const target = Buffer.concat([prefix(), short(Buffer.from(socketPath))]);
    expect(encodeBootstrap({ ...correlation, socketPath })).toEqual(header("MXZBOOT\0", 1, target));
    expect(encodeTarget({ ...correlation, socketPath })).toEqual(header("MXZINIT\0", 2, target));
    expect(decodeBootstrapAck(header("MXZBOOT\0", 2, Buffer.concat([correlation.generation, correlation.nonce])), correlation)).toBeUndefined();
  });
  it("decodes exact UTF8 own entries into a null-prototype map without invoking prototype setters", () => {
    const frame = reply([[Buffer.from("HOME"), Buffer.from("/owned/雪\nvalue")], [Buffer.from("__proto__"), Buffer.from("ordinary")]]);
    const environment = decodePreparedReply(frame, correlation);
    expect(Object.getPrototypeOf(environment)).toBeNull();
    expect(Object.keys(environment)).toEqual(["HOME", "__proto__"]);
    expect(environment.HOME).toBe("/owned/雪\nvalue"); expect(environment.__proto__).toBe("ordinary");
  });
  it("rejects header/length/trailing/revision/correlation/digest defects instead of accepting received expectations", () => {
    const original = reply([[Buffer.from("K"), Buffer.from("V")]]);
    for (const offset of [0, 8, 9, 10, 12, 16, 24, 56, original.length - 1]) {
      const changed = Buffer.from(original); changed[offset] ^= 1;
      expect(() => decodePreparedReply(changed, correlation)).toThrow();
    }
    expect(() => decodePreparedReply(Buffer.concat([original, Buffer.from([0])]), correlation)).toThrow();
    expect(() => decodePreparedReply(original.subarray(0, -1), correlation)).toThrow();
    expect(() => decodePreparedReply(reply([], 3n), correlation)).toThrow();
    expect(() => decodeBootstrapAck(header("MXZBOOT\0", 2, Buffer.concat([correlation.generation, Buffer.alloc(32)])), correlation)).toThrow();
  });
  it("rejects unsorted/duplicate/invalid binary environment syntax and resource caps with valid digests", () => {
    const b = Buffer.from;
    for (const entries of [
      [[b("Z"), b("1")], [b("A"), b("2")]], [[b("A"), b("1")], [b("A"), b("2")]],
      [[b(""), b("V")]], [[b("A=B"), b("V")]], [[b("A\0B"), b("V")]], [[b("A"), b("V\0")]],
      [[Buffer.from([0xff]), b("V")]], [[b("A"), Buffer.from([0xff])]],
      [[b("A".repeat(257)), b("V")]], [[b("A"), b("V".repeat(16385))]],
      Array.from({ length: 513 }, (_, n) => [b(`K${String(n).padStart(3, "0")}`), b("V")]),
      [[b("A"), b("v".repeat(16384))], [b("B"), b("v".repeat(16384))], [b("C"), b("v".repeat(16384))]],
    ] as Array<Array<[Buffer, Buffer]>>) expect(() => decodePreparedReply(reply(entries), correlation)).toThrow();
    expect(() => decodePreparedReply(Buffer.alloc(65537), correlation)).toThrow();
  });
  it("rejects noncanonical session/local paths and invalid fixed-size/raw-deadline inputs", () => {
    for (const fields of [{ sessionName: "../other" }, { layoutPath: "relative.kdl" }, { layoutPath: "https://invalid.example.invalid/a" },
      { layoutPath: "/a\0b" }, { layoutPath: "/" + "x".repeat(4096) }, { generation: Buffer.alloc(31) }, { nonce: Buffer.alloc(33) },
      { deadlineNs: 0n }, { deadlineNs: 1n << 64n }]) {
      expect(() => encodePreparation({ ...correlation, sessionName, layoutPath: "/owned/layout.kdl", ...fields })).toThrow();
    }
    expect(() => encodeTarget({ ...correlation, socketPath: "/" + "x".repeat(103) })).toThrow();
  });
});
