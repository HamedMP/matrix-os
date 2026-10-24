import { spawnSync } from "node:child_process";
import { constants, generateKeyPairSync, privateEncrypt } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Resolve the actual Expo / Metro signing and image dependencies shipped in the
// host bundle. Do not substitute a parser or load a separately installed copy.
const mobile = createRequire(new URL("../../apps/mobile/package.json", import.meta.url));
const expo = createRequire(mobile.resolve("expo/package.json"));
const cli = createRequire(expo.resolve("@expo/cli/package.json"));
const reactNative = createRequire(mobile.resolve("react-native/package.json"));
const nativeCli = createRequire(reactNative.resolve("@react-native/community-cli-plugin/package.json"));
const metro = createRequire(nativeCli.resolve("metro/package.json"));
const imagePath = metro.resolve("image-size");
const imageSize = metro("image-size") as ((input: Uint8Array | string, callback?: (error: Error | null, result?: unknown) => void) => { width: number; height: number; type: string }) & { imageSize: unknown };
const forge = cli("node-forge");

function box(type: string, payload: Buffer, size = payload.length + 8): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

const jxlSignature = Buffer.from("0000000c4a584c200d0a870a", "hex");
const jxlBrand = box("ftyp", Buffer.from("6a786c20000000006a786c20", "hex"));
const heifBrand = box("ftyp", Buffer.from("617669660000000061766966", "hex"));

function icns(length: number, entryLength: number, entryType = "icp4"): Buffer {
  const input = Buffer.alloc(16);
  input.write("icns");
  input.writeUInt32BE(length, 4);
  input.write(entryType, 8);
  input.writeUInt32BE(entryLength, 12);
  return input;
}

// A vulnerable parser can synchronously block forever. Execute each malicious
// input in a fresh process with a kill deadline rather than hanging a CI worker.
function rejectsWithinDeadline(input: Buffer): void {
  const script = `const size = require(process.argv[1]);
    try { size(Buffer.from(process.argv[2], 'base64')); process.exitCode = 2; }
    catch (error) { if (!(error instanceof Error)) throw error; process.stdout.write('rejected'); }`;
  const result = spawnSync(process.execPath, ["-e", script, imagePath, input.toString("base64")], {
    timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 16_384, env: {},
  });
  expect(result.error, "image parsing exceeded its process deadline").toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toBe("rejected");
}

describe("image-size 1.x security backport", () => {
  it.each([0, 1, 7, 0xffff_ffff])("rejects JXL partial-stream box length %s", (length) => {
    rejectsWithinDeadline(Buffer.concat([jxlSignature, jxlBrand, box("jxlp", Buffer.alloc(4), length)]));
  });

  it.each([0, 1, 7, 0xffff_ffff])("rejects HEIF metadata box length %s", (length) => {
    rejectsWithinDeadline(Buffer.concat([heifBrand, box("meta", Buffer.alloc(4), length)]));
  });

  it.each([0, 1, 7, 0xffff_ffff])("rejects ICNS entry length %s", (length) => {
    rejectsWithinDeadline(icns(16, length));
  });

  it("rejects an ICNS entry beyond the declared container boundary", () => {
    rejectsWithinDeadline(icns(12, 8));
  });

  it("retains the synchronous callable, named, path and callback 1.x API", async () => {
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png);
    png.writeUInt32BE(17, 16); png.writeUInt32BE(23, 20);
    expect(typeof imageSize).toBe("function");
    expect(imageSize.imageSize).toBe(imageSize);
    expect(imageSize(png)).toMatchObject({ width: 17, height: 23, type: "png" });
    expect(metro("metro/private/Assets").getAssetSize("png", png, "fixture.png")).toEqual({ width: 17, height: 23 });
    const directory = mkdtempSync(join(tmpdir(), "matrix-image-size-regression-"));
    try {
      const path = join(directory, "fixture.png");
      writeFileSync(path, png);
      expect(imageSize(path)).toMatchObject({ width: 17, height: 23, type: "png" });
      await expect(new Promise((resolve, reject) => {
        imageSize(path, (error, result) => error ? reject(error) : resolve(result));
      })).resolves.toMatchObject({ width: 17, height: 23, type: "png" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("retains normal ICNS dimensions", () => {
    expect(imageSize(icns(16, 8))).toMatchObject({ width: 16, height: 16, type: "icp4" });
  });

  it("retains ICNS dimensions from a buffered header of a large file", () => {
    // The 1.x filename API intentionally reads at most 512KiB. Entry payloads
    // need not be present when the complete header already establishes size.
    expect(imageSize(icns(1_048_576, 1_048_568))).toMatchObject({ width: 16, height: 16, type: "icp4" });
  });

  it("retains normal HEIF dimensions", () => {
    const dimensions = Buffer.alloc(12);
    dimensions.writeUInt32BE(17, 4); dimensions.writeUInt32BE(23, 8);
    const input = Buffer.concat([heifBrand, box("meta", Buffer.concat([
      Buffer.alloc(4), box("iprp", box("ipco", box("ispe", dimensions))),
    ]))]);
    expect(imageSize(input)).toMatchObject({ width: 17, height: 23, type: "avif" });
  });

  it.each(["jxlc", "jxlp"])("retains normal JXL %s dimensions", (type) => {
    const codestream = Buffer.from("ff0a0100", "hex");
    const payload = type === "jxlp" ? Buffer.concat([Buffer.alloc(4), codestream]) : codestream;
    expect(imageSize(Buffer.concat([jxlSignature, jxlBrand, box(type, payload)])))
      .toMatchObject({ width: 8, height: 8, type: "jxl" });
  });
});

function browserForge(name: string) {
  const module = { exports: {} };
  runInNewContext(readFileSync(cli.resolve(`node-forge/dist/${name}`), "utf8"), {
    module, exports: module.exports, window: {}, console, Uint8Array, ArrayBuffer,
    // forge.all registers optional form/XHR closures against jQuery. Those
    // transports stay unavailable; the RSA/ASN.1 implementations remain real.
    jQuery: null, setTimeout, clearTimeout,
  }, { timeout: 2_000 });
  return module.exports as typeof forge;
}

describe.each([
  ["CommonJS entry", forge],
  ["browser distribution", browserForge("forge.min.js")],
  ["all browser distribution", browserForge("forge.all.min.js")],
])("node-forge nested DigestAlgorithm backport (%s)", (_name, forge) => {
  // Test-only e=3 key: this is the low-exponent trust boundary in the advisory.
  // Private exponentiation makes deliberately malformed encoded signatures;
  // it proves the verifier rejects their ASN.1 structure, not just a bad hash.
  const key = generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 3 });
  const publicKey = forge.pki.publicKeyFromPem(key.publicKey.export({ type: "spki", format: "pem" }).toString());
  const digest = forge.md.sha256.create().update("Matrix synthetic signature fixture").digest().getBytes();
  const asn1 = forge.asn1;
  const universal = asn1.Class.UNIVERSAL;
  const element = (type: number, value: unknown, constructed = false) => asn1.create(universal, type, constructed, value);

  function signature(includeNull: boolean, extra: unknown[] = []): string {
    const algorithm = [element(asn1.Type.OID, asn1.oidToDer(forge.oids.sha256).getBytes()),
      ...(includeNull ? [element(asn1.Type.NULL, "")] : []), ...extra];
    const info = element(asn1.Type.SEQUENCE, [element(asn1.Type.SEQUENCE, algorithm, true),
      element(asn1.Type.OCTETSTRING, digest)], true);
    const der = Buffer.from(asn1.toDer(info).getBytes(), "binary");
    const encoded = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(128 - der.length - 3, 0xff), Buffer.from([0]), der]);
    return privateEncrypt({ key: key.privateKey, padding: constants.RSA_NO_PADDING }, encoded).toString("binary");
  }

  it.each([true, false])("rejects surplus nested OCTET STRING (NULL parameters: %s)", (includeNull) => {
    const malformed = signature(includeNull, [element(asn1.Type.OCTETSTRING, "unconsumed")]);
    expect(() => publicKey.verify(digest, malformed)).toThrow(/DigestInfo/);
  });

  it("rejects repeated NULL parameters", () => {
    expect(() => publicKey.verify(digest, signature(true, [element(asn1.Type.NULL, "")]))).toThrow(/DigestInfo/);
  });

  it.each([true, false])("retains valid SHA-256 signatures (NULL parameters: %s)", (includeNull) => {
    expect(publicKey.verify(digest, signature(includeNull))).toBe(true);
  });

  it("still rejects a changed digest", () => {
    const changed = forge.md.sha256.create().update("Different synthetic message").digest().getBytes();
    expect(publicKey.verify(changed, signature(true))).toBe(false);
  });

  it("retains Expo certificate, CSR and manifest signing compatibility", () => {
    const signing = cli("@expo/code-signing-certificates");
    const keyPair = signing.convertKeyPairPEMToKeyPair({
      publicKeyPEM: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPEM: key.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    });
    const certificate = signing.generateSelfSignedCodeSigningCertificate({
      keyPair, validityNotBefore: new Date(Date.now() - 60_000),
      validityNotAfter: new Date(Date.now() + 60_000), commonName: "Matrix synthetic test certificate",
    });
    signing.validateSelfSignedCertificate(certificate, keyPair);
    const csr = signing.generateCSR(keyPair, "Matrix synthetic test CSR");
    expect(csr.verify()).toBe(true);
    const message = Buffer.from("Matrix synthetic manifest fixture");
    const signature = signing.signBufferRSASHA256AndVerify(keyPair.privateKey, certificate, message);
    expect(publicKey.verify(forge.md.sha256.create().update(message.toString("binary")).digest().getBytes(),
      forge.util.decode64(signature))).toBe(true);
  });
});
