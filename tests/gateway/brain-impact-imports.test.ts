/**
 * Impact brief import graph and path rules: specifier parsing, package.json exports, resolution, dependents, test
 * coverage rules and spec folders. Pure.
 */
import { describe, expect, it } from "vitest";
import {
  addImports, createImportGraph, findDependents, isSourcePath, resolveSpecifier, specifierOf, workspacePackage,
  type WorkspacePackage,
} from "../../packages/gateway/src/brain/impact/imports.js";
import {
  IMPACT_SPEC_PATHS_MAX, isCodePath, isTestPath, packageRootOf, specsTouched, untestedFiles,
} from "../../packages/gateway/src/brain/impact/paths.js";
import type { ImpactChange } from "../../packages/gateway/src/brain/impact/git.js";

const FILES = new Set([
  "src/a.ts", "src/b.tsx", "src/c.mts", "src/d.cts", "src/view.tsx", "src/folder/index.ts", "src/plain.js",
  "pkg/core/src/index.ts", "pkg/core/src/util/x.ts", "pkg/core/lib/main.js", "pkg/deep/src/y.ts", "pkg/deep/index.ts",
  "pkg/nested/src/n.ts",
]);

function pkg(root: string, json: unknown): WorkspacePackage {
  const parsed = workspacePackage(root, json);
  if (parsed === null) throw new Error("no package");
  return parsed;
}

const PACKAGES = [
  pkg("pkg/nested", { name: "@acme/core-nested", exports: "./src/n.ts" }),
  pkg("pkg/core", {
    name: "@acme/core",
    exports: {
      ".": [{ types: "./src/index.ts" }, "./dist/index.js"], "./util/*": { import: "./src/util/*.ts" },
      "./missing": "./src/missing.ts", "./lib": { default: { node: "./lib/main.js" } },
    },
  }),
  pkg("pkg/deep", { name: "deep" }),
  pkg("", { name: "root-main", main: "./src/a.ts" }),
].sort((a, b) => b.name.length - a.name.length);

const change = (path: string, status: ImpactChange["status"] = "modified", previousPath: string | null = null): ImpactChange =>
  ({ path, status, previousPath });

describe("specifiers and packages", () => {
  it("reads the specifier of each import form", () => {
    expect(specifierOf(" from \"./a.js\"")).toBe("./a.js");
    expect(specifierOf("import('./b')")).toBe("./b");
    expect(specifierOf("require( \"x\" )")).toBe("x");
    expect(specifierOf("from \"./a.js'")).toBeNull();
    expect(isSourcePath("a.d.ts")).toBe(false);
    expect(isSourcePath("a.mjs")).toBe(true);
    expect(isSourcePath("a.md")).toBe(false);
  });

  it("parses package.json name, exports and main", () => {
    expect(workspacePackage("", [])).toBeNull();
    expect(workspacePackage("", null)).toBeNull();
    expect(workspacePackage("", { name: "Bad Name" })).toBeNull();
    expect(workspacePackage("", { name: 7 })).toBeNull();
    expect(workspacePackage("p", { name: "p", exports: null, main: 3 })).toEqual({ name: "p", root: "p", exports: null, main: null });
    expect(workspacePackage("p", { name: "p", main: "../../x.js" })!.main).toBeNull();
    const conditions = workspacePackage("p", { name: "p", exports: { import: "./a.js", require: ["./b.js", "c.js"] } })!;
    expect([...conditions.exports!]).toEqual([[".", ["p/a.js", "p/b.js"]]]);
    const deep = { a: { b: { c: { d: { e: "./too-deep.js" } } } } };
    expect([...workspacePackage("p", { name: "p", exports: deep })!.exports!]).toEqual([[".", []]]);
    expect([...workspacePackage("p", { name: "p", exports: { ".": null, "./n": 5 } })!.exports!]).toEqual([[".", []], ["./n", []]]);
    const many = Array.from({ length: 30 }, (_, i) => `./f${i}.js`);
    expect(workspacePackage("p", { name: "p", exports: { ".": many } })!.exports!.get(".")).toHaveLength(16);
  });
});

describe("resolution", () => {
  const resolve = (from: string, specifier: string) => resolveSpecifier(from, specifier, FILES, PACKAGES);

  it("resolves relative paths with compiled extensions, missing extensions and index files", () => {
    expect(resolve("src/z.ts", "./a.js")).toBe("src/a.ts");
    expect(resolve("src/z.ts", "./b.js")).toBe("src/b.tsx");
    expect(resolve("src/z.ts", "./view.jsx")).toBe("src/view.tsx");
    expect(resolve("src/z.ts", "./c.mjs")).toBe("src/c.mts");
    expect(resolve("src/z.ts", "./d.cjs")).toBe("src/d.cts");
    expect(resolve("src/z.ts", "./plain.js")).toBe("src/plain.js");
    expect(resolve("src/z.ts", "./a")).toBe("src/a.ts");
    expect(resolve("src/z.ts", "./folder")).toBe("src/folder/index.ts");
    expect(resolve("src/folder/index.ts", "..")).toBeNull();
    expect(resolve("z.ts", "..")).toBeNull();
    expect(resolve("z.ts", ".")).toBeNull();
    expect(resolve("src/z.ts", "./folder/")).toBe("src/folder/index.ts");
    expect(resolve("src/folder/index.ts", ".")).toBe("src/folder/index.ts");
    expect(resolve("src/z.ts", "../../outside.js")).toBeNull();
    expect(resolve("src/z.ts", "./nope.js")).toBeNull();
  });

  it("resolves workspace packages through exports, patterns, main and deep paths", () => {
    expect(resolve("x.ts", "@acme/core")).toBe("pkg/core/src/index.ts");
    expect(resolve("x.ts", "@acme/core/util/x")).toBe("pkg/core/src/util/x.ts");
    expect(resolve("x.ts", "@acme/core/lib")).toBe("pkg/core/lib/main.js");
    expect(resolve("x.ts", "@acme/core/missing")).toBeNull();
    expect(resolve("x.ts", "@acme/core/hidden")).toBeNull();
    expect(resolve("x.ts", "@acme/core-nested")).toBe("pkg/nested/src/n.ts");
    expect(resolve("x.ts", "deep")).toBe("pkg/deep/index.ts");
    expect(resolve("x.ts", "deep/src/y.js")).toBe("pkg/deep/src/y.ts");
    expect(resolve("x.ts", "deep/../../../x")).toBeNull();
    expect(resolve("x.ts", "root-main")).toBe("src/a.ts");
    expect(resolve("x.ts", "react")).toBeNull();
  });

  it("picks the most specific export pattern, whatever the key order", () => {
    const files = new Set(["p/src/util/x.ts", "p/src/utils/x.ts", "p/src/b.ts", "p/js/y.ts", "p/src/internal/z.ts"]);
    const packages = [pkg("p", {
      name: "p",
      exports: {
        "./*": "./src/*.ts", "./util/*": "./src/utils/*.ts", "./internal/*": null, "./x/*": "./src/*.ts",
        "./x/*.js": "./js/*.ts",
      },
    })];
    const resolve = (specifier: string) => resolveSpecifier("x.ts", specifier, files, packages);
    expect(resolve("p/util/x")).toBe("p/src/utils/x.ts");
    expect(resolve("p/b")).toBe("p/src/b.ts");
    expect(resolve("p/internal/z")).toBeNull();
    expect(resolve("p/x/y.js")).toBe("p/js/y.ts");
  });
});

describe("dependents", () => {
  it("builds rings up to the depth, skips changed files and caps", () => {
    const graph = createImportGraph();
    addImports(graph, [
      { path: "b.ts", text: "from \"./a.js\"" }, { path: "b.ts", text: "from \"./a\"" },
      { path: "c.ts", text: "from \"./b.js\"" }, { path: "a2.ts", text: "from \"./a.js\"" },
      { path: "a.ts", text: "from \"./a.js\"" }, { path: "d.ts", text: "no import here" },
      { path: "e.ts", text: "from \"./unknown.js\"" },
    ], new Set(["a.ts", "a2.ts", "b.ts", "c.ts", "d.ts"]), [], 10);
    expect(graph.edges).toBe(3);
    const changed = new Set(["a.ts", "a2.ts"]);
    expect(findDependents(graph, ["a.ts", "a2.ts"], changed, 1, 10)).toEqual({
      dependents: [{ path: "b.ts", depth: 1, via: "a.ts" }], totals: { depth1: 1, depth2: null }, capped: false,
    });
    expect(findDependents(graph, ["a.ts"], changed, 2, 10)).toEqual({
      dependents: [{ path: "b.ts", depth: 1, via: "a.ts" }, { path: "c.ts", depth: 2, via: "b.ts" }],
      totals: { depth1: 1, depth2: 1 }, capped: false,
    });
    expect(findDependents(graph, ["a.ts"], changed, 2, 1)).toEqual({
      dependents: [{ path: "b.ts", depth: 1, via: "a.ts" }], totals: { depth1: 1, depth2: 1 }, capped: true,
    });
    const small = createImportGraph();
    addImports(small, [{ path: "b.ts", text: "from \"./a.js\"" }, { path: "c.ts", text: "from \"./a.js\"" }],
      new Set(["a.ts", "b.ts", "c.ts"]), [], 1);
    expect([small.edges, small.capped]).toEqual([1, true]);
  });
});

describe("dependent ranking", () => {
  const edges = (pairs: ReadonlyArray<readonly [string, string]>) => {
    const graph = createImportGraph();
    const files = new Set(pairs.flatMap(([from, to]) => [from, `${to}.ts`]));
    addImports(graph, pairs.map(([path, to]) => ({ path, text: `from "./${to}.js"` })), files, [], 100);
    return graph;
  };

  it("ranks by depth, then by files of the ring before imported, then by path", () => {
    // Changed: a, b, c. x imports all three, y two, z one; w imports x and y (two depth-1 files), v imports z.
    // y also imports x: a depth-1 file never counts again at depth 2.
    const graph = edges([
      ["z.ts", "a"], ["y.ts", "a"], ["y.ts", "b"], ["x.ts", "c"], ["x.ts", "b"], ["x.ts", "a"],
      ["v.ts", "z"], ["w.ts", "y"], ["w.ts", "x"], ["y.ts", "x"], ["a.ts", "b"],
    ]);
    const found = findDependents(graph, ["c.ts", "a.ts", "b.ts", "a.ts"], new Set(["a.ts", "b.ts", "c.ts"]), 2, 10);
    expect(found.dependents).toEqual([
      { path: "x.ts", depth: 1, via: "a.ts" }, { path: "y.ts", depth: 1, via: "a.ts" },
      { path: "z.ts", depth: 1, via: "a.ts" }, { path: "w.ts", depth: 2, via: "x.ts" },
      { path: "v.ts", depth: 2, via: "z.ts" },
    ]);
    expect(found.totals).toEqual({ depth1: 3, depth2: 2 });
    const top = findDependents(graph, ["a.ts", "b.ts", "c.ts"], new Set(["a.ts", "b.ts", "c.ts"]), 2, 2);
    expect([top.dependents.map((item) => item.path), top.totals, top.capped])
      .toEqual([["x.ts", "y.ts"], { depth1: 3, depth2: 2 }, true]);
  });
});

describe("path rules", () => {
  it("classifies tests, code and package folders", () => {
    for (const path of ["tests/a.ts", "src/__tests__/a.ts", "a.test.tsx", "a.spec.mjs", "x_test.go", "test_x.py", "e2e/a.ts"]) {
      expect(isTestPath(path)).toBe(true);
    }
    expect(isTestPath("src/testing.ts")).toBe(false);
    expect(isCodePath("src/a.ts")).toBe(true);
    expect(isCodePath("src/a.d.ts")).toBe(false);
    expect(isCodePath("README.md")).toBe(false);
    const roots = new Set(["", "pkg/core"]);
    expect(packageRootOf("pkg/core/src/a.ts", roots)).toBe("pkg/core");
    expect(packageRootOf("other/a.ts", roots)).toBe("");
    expect(packageRootOf("a.ts", roots)).toBe("");
  });

  it("finds changed code no changed test names or imports, whatever folder the tests sit in", () => {
    const changed = [
      change("pkg/core/src/a.ts"), change("pkg/core/src/a.test.ts"), change("pkg/core/src/e.ts"),
      change("pkg/core/src/b.ts"), change("pkg/core/tests/b-unit.ts"),
      change("pkg/app/src/c.ts"), change("tests/app/c-flow.test.ts"),
      change("lib/my_mod.py"), change("other/test_my_mod.py"),
      change("tools/run.ts"), change("tests/z.test.ts"),
      change("src/gone.ts", "deleted"), change("src/lone.ts", "added"), change("docs/readme.md"),
      change("src/old-test.ts"), change("tests/old.test.ts", "deleted"),
    ];
    expect(untestedFiles(changed, new Map(), 10)).toEqual([
      { path: "pkg/core/src/e.ts" }, { path: "src/lone.ts" }, { path: "src/old-test.ts" }, { path: "tools/run.ts" },
    ]);
    expect(untestedFiles(changed, new Map(), 1)).toEqual([{ path: "pkg/core/src/e.ts" }]);
    const imports = new Map([["tests/z.test.ts", new Set(["tools/run.ts", "pkg/core/src/e.ts"])]]);
    expect(untestedFiles(changed, imports, 10)).toEqual([{ path: "src/lone.ts" }, { path: "src/old-test.ts" }]);
  });

  it("groups changed paths by spec folder", () => {
    const many = Array.from({ length: IMPACT_SPEC_PATHS_MAX + 2 }, (_, i) => change(`specs/002-b/f${i}.md`));
    const specs = specsTouched([
      change("specs/003-c/spec.md", "renamed", "specs/001-a/spec.md"), change("src/a.ts"), ...many,
      change("specs/003-c/spec.md"),
    ], 2);
    expect(specs.map((spec) => spec.spec)).toEqual(["specs/001-a", "specs/002-b"]);
    expect(specs[1]!.changedPaths).toHaveLength(IMPACT_SPEC_PATHS_MAX);
    expect(specsTouched([change("specs/x")], 5)).toEqual([]);
  });
});
