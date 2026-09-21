import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type ConditionalExport = {
  "react-native"?: string;
  default?: string;
};

const uiRoot = resolve(__dirname, "../../../packages/ui");
const uiPackage = require("../../../packages/ui/package.json") as {
  exports?: Record<string, string | ConditionalExport>;
};

function sourceModuleExists(origin: string, specifier: string): boolean {
  const candidate = resolve(dirname(origin), specifier);
  return [candidate, `${candidate}.ts`, `${candidate}.tsx`, join(candidate, "index.ts")]
    .some((path) => existsSync(path));
}

describe("Native Mobile shared speech Metro entry", () => {
  it("selects a React Native source entry with Metro-resolvable imports", () => {
    const speechExport = uiPackage.exports?.["./speech"];
    expect(speechExport).toBeTruthy();
    expect(typeof speechExport).toBe("object");
    if (!speechExport || typeof speechExport === "string") return;

    expect(Object.keys(speechExport).slice(0, 2)).toEqual(["react-native", "default"]);
    expect(speechExport.default).toBe("./src/speech/index.ts");
    expect(speechExport["react-native"]).toBe("./src/speech/native.ts");

    const nativeEntry = resolve(uiRoot, speechExport["react-native"] ?? "");
    const nativeSource = readFileSync(nativeEntry, "utf8");
    const relativeSpecifiers = Array.from(
      nativeSource.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g),
      (match) => match[1] ?? "",
    );

    expect(relativeSpecifiers.length).toBeGreaterThan(0);
    for (const specifier of relativeSpecifiers) {
      expect(specifier).not.toMatch(/\.[cm]?js$/);
      expect(sourceModuleExists(nativeEntry, specifier)).toBe(true);
    }

    // The default entry keeps explicit `.js` specifiers for emitted Node ESM.
    expect(readFileSync(resolve(uiRoot, speechExport.default ?? ""), "utf8"))
      .toContain("./use-platform-speech-draft.js");
  });
});
