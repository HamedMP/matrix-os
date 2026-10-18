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
});
