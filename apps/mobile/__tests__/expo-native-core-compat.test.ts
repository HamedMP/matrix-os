import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  coreImports,
  createCoreIndex,
  indexSource,
  languageOf,
  resolvesInCore,
  type CoreIndex,
} from "./native-core-symbols";

// Expo ships its Android modules as prebuilt AARs, so a module that is newer
// than the installed expo-modules-core still builds and only fails on device:
// @expo/ui 57.0.13 against core 57.0.2 crashed every Compose `Host` with
// `NoClassDefFoundError: expo/modules/kotlin/types/ColorCompat`. Nothing in the
// JS suite or the Gradle build sees that, so link the shipped Kotlin sources
// here instead.

type MobilePackageConfig = {
  dependencies?: Record<string, string>;
};

const packageConfig = require("../package.json") as MobilePackageConfig;
const expoRoot = dirname(require.resolve("expo/package.json"));
const coreRoot = dirname(
  require.resolve("expo-modules-core/package.json", { paths: [expoRoot] }),
);

function listSources(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return listSources(entryPath);
    return /\.(kt|java)$/.test(entry.name) ? [entryPath] : [];
  });
}

function indexCore(): CoreIndex {
  const index = createCoreIndex();
  for (const file of listSources(join(coreRoot, "android/src"))) {
    indexSource(index, readFileSync(file, "utf8"), languageOf(file));
  }
  return index;
}

function unresolvedCoreImports(moduleName: string, index: CoreIndex): string[] {
  const moduleRoot = join(__dirname, "../node_modules", moduleName);
  const unresolved: Record<string, true> = {};
  for (const file of listSources(join(moduleRoot, "android/src"))) {
    for (const importPath of coreImports(readFileSync(file, "utf8"), languageOf(file))) {
      if (!resolvesInCore(index, importPath)) unresolved[`${moduleName}: ${importPath}`] = true;
    }
  }
  return Object.keys(unresolved);
}

describe("Expo native module compatibility with the installed core", () => {
  const expoModules = Object.keys(packageConfig.dependencies ?? {}).filter(
    (name) => name.startsWith("expo-") || name.startsWith("@expo/"),
  );
  const index = indexCore();

  it("indexes the expo-modules-core Android sources", () => {
    expect(resolvesInCore(index, "expo.modules.kotlin.modules.Module")).toBe(true);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.toKClass")).toBe(true);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.NotARealClass")).toBe(false);
  });

  it("only imports core classes that the installed expo-modules-core ships", () => {
    const unresolved = expoModules.flatMap((name) => unresolvedCoreImports(name, index));

    expect(unresolved).toEqual([]);
  });

  it("checks the Compose module that renders the chat pickers", () => {
    expect(expoModules).toContain("@expo/ui");
    const imports = listSources(join(__dirname, "../node_modules/@expo/ui/android/src")).flatMap((file) =>
      coreImports(readFileSync(file, "utf8"), languageOf(file)),
    );
    // The class whose absence crashed every Compose `Host`.
    expect(imports).toContain("expo.modules.kotlin.types.ColorCompat");
  });
});
