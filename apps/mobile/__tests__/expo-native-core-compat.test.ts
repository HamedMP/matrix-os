import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Expo ships its Android modules as prebuilt AARs, so a module that is newer
// than the installed expo-modules-core still builds and only fails on device:
// @expo/ui 57.0.13 against core 57.0.2 crashed every Compose `Host` with
// `NoClassDefFoundError: expo/modules/kotlin/types/ColorCompat`. Nothing in the
// JS suite or the Gradle build sees that, so link the shipped Kotlin sources
// here instead.

type MobilePackageConfig = {
  dependencies?: Record<string, string>;
};

const CORE_IMPORT = /^import\s+(expo\.modules\.(?:kotlin|core)\.[\w.]+)/gm;
const PACKAGE_DECLARATION = /^package\s+([\w.]+)/m;
const DECLARATIONS = [
  // `enum` alone is the Java form; Kotlin's `enum class Name` is matched by `class`.
  /\b(?:class|object|interface|typealias|enum(?!\s+class))\s+(\w+)/g,
  /\bfun\b[^(\n]*?(\w+)\s*\(/g,
  /\b(?:val|var)\s+(?:<[^>]*>\s*)?(?:[\w<>?,.]+\.)?(\w+)/g,
];

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

function declaredCoreSymbols(): Set<string> {
  const symbols = new Set<string>();
  for (const file of listSources(join(coreRoot, "android/src"))) {
    const source = readFileSync(file, "utf8");
    const packageName = PACKAGE_DECLARATION.exec(source)?.[1];
    if (!packageName) continue;
    for (const pattern of DECLARATIONS) {
      for (const match of source.matchAll(pattern)) {
        symbols.add(`${packageName}.${match[1]}`);
      }
    }
  }
  return symbols;
}

// `a.b.Outer.Inner` resolves once any prefix names a declaration in core, so
// nested classes and companion members do not need to be modelled.
function resolvesInCore(importPath: string, symbols: Set<string>): boolean {
  const segments = importPath.split(".");
  for (let end = segments.length; end > 3; end -= 1) {
    if (symbols.has(segments.slice(0, end).join("."))) return true;
  }
  return false;
}

function unresolvedCoreImports(moduleName: string, symbols: Set<string>): string[] {
  const moduleRoot = join(__dirname, "../node_modules", moduleName);
  const unresolved = new Set<string>();
  for (const file of listSources(join(moduleRoot, "android/src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(CORE_IMPORT)) {
      if (!resolvesInCore(match[1], symbols)) {
        unresolved.add(`${moduleName}: ${match[1]}`);
      }
    }
  }
  return [...unresolved];
}

describe("Expo native module compatibility with the installed core", () => {
  const expoModules = Object.keys(packageConfig.dependencies ?? {}).filter(
    (name) => name.startsWith("expo-") || name.startsWith("@expo/"),
  );
  const symbols = declaredCoreSymbols();

  it("indexes the expo-modules-core Android sources", () => {
    expect(symbols.has("expo.modules.kotlin.modules.Module")).toBe(true);
  });

  it("only imports core classes that the installed expo-modules-core ships", () => {
    const unresolved = expoModules.flatMap((name) => unresolvedCoreImports(name, symbols));

    expect(unresolved).toEqual([]);
  });

  it("checks the Compose module that renders the chat pickers", () => {
    expect(expoModules).toContain("@expo/ui");
    expect(listSources(join(__dirname, "../node_modules/@expo/ui/android/src"))).not.toEqual([]);
  });
});
