import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const desktopRequire = createRequire(resolve("desktop/package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const signingPath = builderRequire.resolve("app-builder-lib/out/codeSign/macCodeSign.js");
const signingRequire = createRequire(signingPath);

describe("installed macOS signing dependency", () => {
  it.each([false, true])("uses the keychain password for ACL setup (installer certificate: %s)", async (installer) => {
    const commands: string[][] = [];
    const signing: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    // Exercise the installed dependency while replacing only OS/certificate I/O.
    // No real keychain, certificate, or credential is accessed by this test.
    runInNewContext(readFileSync(signingPath, "utf8"), {
      exports: signing,
      __dirname: dirname(signingPath),
      process: { env: { TRAVIS: "true" }, platform: "darwin" },
      require: (name: string) => {
        if (name === "builder-util") return {
          exec: async (executable: string, args: string[]) => {
            expect(executable).toBe("/usr/bin/security");
            commands.push(Array.from(args));
            return "";
          },
        };
        if (name === "./codesign") return {
          importCertificate: async (link: string) => `/fixture/${link}.p12`,
        };
        return signingRequire(name);
      },
    });
    await signing.createKeychain({
      tmpDir: {},
      currentDir: "/fixture/app",
      cscLink: "application",
      cscKeyPassword: "application-certificate-password",
      ...(installer ? { cscILink: "installer", cscIKeyPassword: "installer-certificate-password" } : {}),
    });

    const create = commands.find((args) => args[0] === "create-keychain")!;
    const keychainPassword = create[2];
    const keychainPath = create[3];
    expect(keychainPassword).toBeTruthy();
    expect(keychainPassword).not.toBe("application-certificate-password");
    expect(commands).toContainEqual(["unlock-keychain", "-p", keychainPassword, keychainPath]);
    const imports = commands.filter((args) => args[0] === "import");
    expect(imports.map((args) => args[args.indexOf("-P") + 1])).toEqual(
      installer ? ["application-certificate-password", "installer-certificate-password"] : ["application-certificate-password"],
    );
    const partitions = commands.filter((args) => args[0] === "set-key-partition-list");
    expect(partitions).toHaveLength(imports.length);
    for (const args of partitions) {
      expect(args[args.indexOf("-k") + 1]).toBe(keychainPassword);
      expect(args.at(-1)).toBe(keychainPath);
    }
  });
});
