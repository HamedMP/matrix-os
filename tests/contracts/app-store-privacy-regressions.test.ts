import { describe, expect, it } from "vitest";
import { redactSecrets, scanAppFiles } from "../../packages/contracts/src/app-store-scan";

describe("publishing privacy boundaries", () => {
  it("removes the complete private key before source goes to AI", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIEvSECRET_PRIVATE_BYTES\nMORE_PRIVATE_BYTES\n-----END PRIVATE KEY-----";
    const redacted = redactSecrets(`const key = ${JSON.stringify(key)};`);
    expect(redacted.text).not.toContain("SECRET_PRIVATE_BYTES");
    expect(redacted.text).not.toContain("MORE_PRIVATE_BYTES");
    expect(redactSecrets(key).text).not.toContain("SECRET_PRIVATE_BYTES");
  });
  it("fails closed when findings are truncated before a later secret", () => {
    const text = Array.from({ length: 501 }, () => "const email = 'person@company.com';").join("\n") + "\nconst key = 'sk-ant-abcdefghijklmnopqrstuvwxyz';";
    const report = scanAppFiles(new Map([["src/main.ts", Buffer.from(text)]]));
    expect(report.truncated).toBe(true);
    expect(report.blocking).toBe(true);
  });
  it("does not skip credentials embedded in a lockfile URL", () => {
    const report = scanAppFiles(new Map([["pnpm-lock.yaml", Buffer.from("tarball: https://user:PasswordVerySecret99@registry.example.com/package.tgz")]]));
    expect(report.blocking).toBe(true);
    expect(JSON.stringify(report)).not.toContain("PasswordVerySecret99");
  });
  it("checks private keys without extensions and secrets in asset metadata", () => {
    const report = scanAppFiles(new Map([
      ["id_rsa", Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----")],
      ["public/photo.png", Buffer.from("\x89PNG\0metadata: sk-ant-abcdefghijklmnopqrstuvwxyz")],
    ]));
    expect(report.findings.filter(f => f.category === "secret")).toHaveLength(2);
    expect(report.blocking).toBe(true);
  });
  it("finds owner identity in file names before publication", () => {
    const report = scanAppFiles(new Map([["assets/alice-customer-list.csv", Buffer.from("example")]]), { ownerTerms: ["alice"] });
    expect(report.blocking).toBe(true);
  });
  it("finds owner identity in binary metadata", () => {
    const report = scanAppFiles(new Map([["assets/photo.jpg", Buffer.from("\xff\0Artist: alice")]]), { ownerTerms: ["alice"] });
    expect(report.blocking).toBe(true);
  });
  it("blocks credential-bearing file names without echoing credentials", () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz";
    const report = scanAppFiles(new Map([[`assets/${secret}.txt`, Buffer.from("example")]]));
    expect(report.blocking).toBe(true);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});
