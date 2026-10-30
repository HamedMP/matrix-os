import { expect, test } from "vitest";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const mobileRoot = resolve("apps/mobile");
const require = createRequire(resolve(mobileRoot, "package.json"));
const config = ts.readConfigFile(resolve(mobileRoot, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw new Error("Cannot read native TypeScript configuration");
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, mobileRoot).options;

async function installedPackage(name: string) {
  // Drawer is consumed by Expo Router; follow that edge instead of an incidental hoist.
  const consumer = name === "react-native-drawer-layout"
    ? createRequire(require.resolve("expo-router")) : require;
  let directory = dirname(consumer.resolve(name));
  for (;;) {
    const packagePath = resolve(directory, "package.json");
    try {
      const pkg = JSON.parse(await readFile(packagePath, "utf8"));
      if (pkg.name === name) return { pkg, directory };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot find installed metadata for ${name}`);
    directory = parent;
  }
}

for (const name of ["react-native-svg", "react-native-gesture-handler", "expo-router", "react-native-drawer-layout", "@react-navigation/elements", "expo-image", "posthog-react-native"]) {
  test(`${name} resolves React declarations from its actual installed type consumer`, async () => {
    const { pkg, directory } = await installedPackage(name);
    expect(pkg.types ?? pkg.typings).toBeTruthy();
    const declaration = resolve(directory, pkg.types ?? pkg.typings);
    const resolution = ts.resolveModuleName("react", declaration, options, ts.sys).resolvedModule;
    expect(resolution?.extension, `${name} resolved ${resolution?.resolvedFileName ?? "nothing"}`).toBe(ts.Extension.Dts);
    expect(resolution?.packageId?.name).toBe("@types/react");
  });
}

test("PostHog masking retains real React Native ViewProps", async () => {
  const { directory } = await installedPackage("posthog-react-native");
  const declaration = resolve(directory, "dist/PostHogMaskView.d.ts");
  const resolution = ts.resolveModuleName("react-native", declaration, options, ts.sys).resolvedModule;
  expect(resolution?.extension).toBe(ts.Extension.Dts);
  expect(resolution?.packageId?.name).toBe("react-native");
});
