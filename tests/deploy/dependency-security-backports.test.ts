import { constants, generateKeyPairSync, privateEncrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Resolve the actual Expo / Metro signing and image dependencies shipped in the
// host bundle. Do not substitute a parser or load a separately installed copy.
const mobile = createRequire(new URL("../../apps/mobile/package.json", import.meta.url));
const expo = createRequire(mobile.resolve("expo/package.json"));
const cli = createRequire(expo.resolve("@expo/cli/package.json"));
const forge = cli("node-forge");

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
