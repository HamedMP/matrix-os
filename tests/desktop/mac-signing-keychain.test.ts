import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Resolve the code actually used by the desktop packager, including pnpm patches.
const desktopRequire = createRequire(resolve("desktop/package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const signingRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const builderUtil = signingRequire("builder-util");
const codesign = signingRequire("app-builder-lib/out/codeSign/codesign.js");
const { createKeychain } = signingRequire("app-builder-lib/out/codeSign/macCodeSign.js");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockSecurity(partitionError?: Error) {
  // Skip unrelated root-certificate installation; no real keychains are touched.
  vi.stubEnv("TRAVIS", "true");
  const calls: string[][] = [];
  let keychainPassword: string | undefined;
  vi.spyOn(codesign, "importCertificate").mockImplementation(async (link: string) => link);
  vi.spyOn(builderUtil, "exec").mockImplementation(async (file: string, args: string[]) => {
    expect(file).toBe("/usr/bin/security");
    calls.push(args);
    if (args[0] === "create-keychain") keychainPassword = args[2];
    if (args[0] === "set-key-partition-list") {
      if (args[args.indexOf("-k") + 1] !== keychainPassword) {
        throw new Error("SecKeychainUnlock: incorrect keychain passphrase");
      }
      if (partitionError) throw partitionError;
    }
    return "";
  });
  return calls;
}

describe("desktop signing keychain credentials", () => {
  it.each([
    { name: "application", applicationPassword: "app-certificate-password", installerPassword: undefined },
    { name: "application and installer", applicationPassword: "app-certificate-password", installerPassword: "installer-certificate-password" },
    { name: "unprotected certificate", applicationPassword: "", installerPassword: undefined },
  ])("keeps $name certificate passwords separate from the keychain password", async ({ applicationPassword, installerPassword }) => {
    const calls = mockSecurity();
    const result = await createKeychain({
      tmpDir: {},
      cscLink: "/fixture/application.p12",
      cscKeyPassword: applicationPassword,
      ...(installerPassword === undefined ? {} : {
        cscILink: "/fixture/installer.p12", cscIKeyPassword: installerPassword,
      }),
      currentDir: "/fixture/desktop",
    });
    const created = calls.find((args) => args[0] === "create-keychain")!;
    const keychainPassword = created[2];
    expect(keychainPassword).toBeTruthy();
    expect(keychainPassword).not.toBe(applicationPassword);
    expect(result.keychainFile).toBe(created[3]);
    expect(calls).toContainEqual(["unlock-keychain", "-p", keychainPassword, result.keychainFile]);
    const imports = calls.filter((args) => args[0] === "import");
    expect(imports.map((args) => args[args.indexOf("-P") + 1])).toEqual(
      installerPassword === undefined ? [applicationPassword] : [applicationPassword, installerPassword],
    );
    const partitionCalls = calls.filter((args) => args[0] === "set-key-partition-list");
    expect(partitionCalls).toHaveLength(imports.length);
    for (const args of partitionCalls) {
      expect(args).toEqual(["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, result.keychainFile]);
    }
  });

  it("still rejects failures while granting signing-key access", async () => {
    const error = new Error("keychain access denied");
    mockSecurity(error);
    await expect(createKeychain({
      tmpDir: {}, cscLink: "/fixture/application.p12", cscKeyPassword: "certificate-password", currentDir: "/fixture/desktop",
    })).rejects.toThrow(error);
  });
});

// A root patchedDependencies entry also affects filtered installs. Every
// dependency-only build context must include the patch before pnpm runs.
describe("signing patch build inputs", () => {
  it.each(["Dockerfile", "Dockerfile.platform"])("copies dependency patches before installation in %s", (file) => {
    const source = readFileSync(file, "utf8");
    const copy = source.indexOf("COPY patches/ patches/");
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(source.indexOf("RUN pnpm install"));
  });

  it("keeps host bundle manifests together with the patch they reference", () => {
    const source = readFileSync("scripts/build-host-bundle.sh", "utf8");
    expect(source).toContain('cp -a "$ROOT_DIR/patches" "$STAGE_DIR/app/patches"');
  });
});
