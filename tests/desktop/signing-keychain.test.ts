import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

describe("installed electron-builder signing keychain", () => {
  it.each([false, true])("uses the keychain password for ACLs (installer: %s)", async (installer) => {
    const desktopRequire = createRequire(resolve("desktop/package.json"));
    const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
    const sourcePath = builderRequire.resolve("app-builder-lib/out/codeSign/macCodeSign.js");
    const dependencyRequire = createRequire(sourcePath);
    const commands: string[][] = [];
    let keychainPassword = "";
    const exports = {} as { createKeychain: (options: Record<string, unknown>) => Promise<unknown> };
    runInNewContext(readFileSync(sourcePath, "utf8"), {
      exports,
      process: { env: { TRAVIS: "true" } },
      require: (name: string) => {
        if (name === "builder-util") return {
          exec: async (_command: string, args: string[]) => {
            commands.push(args);
            if (args[0] === "create-keychain") keychainPassword = args[2];
            if (args[0] === "set-key-partition-list" && args[args.indexOf("-k") + 1] !== keychainPassword) {
              throw new Error("SecKeychainUnlock: incorrect keychain password");
            }
            return "";
          },
        };
        if (name === "./codesign") return { importCertificate: async (link: string) => link };
        return dependencyRequire(name);
      },
    });
    await exports.createKeychain({
      tmpDir: {}, currentDir: "/fixture/desktop", cscLink: "application.p12",
      cscKeyPassword: "certificate-password",
      ...(installer ? { cscILink: "installer.p12", cscIKeyPassword: "installer-password" } : {}),
    });
    expect(keychainPassword).not.toBe("certificate-password");
    const imports = commands.filter(([command]) => command === "import");
    expect(imports.map((args) => args[args.indexOf("-P") + 1])).toEqual(
      installer ? ["certificate-password", "installer-password"] : ["certificate-password"],
    );
    expect(commands.filter(([command]) => command === "set-key-partition-list")).toHaveLength(installer ? 2 : 1);
  });
});
