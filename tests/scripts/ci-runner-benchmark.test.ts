import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sha = "a".repeat(40);
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const electronSuites = [
  "tests/e2e/desktop/file-download.e2e.test.ts",
  "tests/e2e/desktop/canonical-input.e2e.test.ts",
  "tests/e2e/provider-authorization-electron.e2e.test.ts",
  "tests/e2e/desktop/provider-auth-terminal.e2e.test.ts",
  "tests/e2e/desktop/agents-providers-figma.e2e.test.ts",
  "tests/e2e/desktop/agents-providers-button-contrast.e2e.test.ts",
  "tests/e2e/desktop/provider-settings-idle.e2e.test.ts",
  "tests/e2e/desktop/project-folder-picker-layout.e2e.test.ts",
  "tests/e2e/desktop/terminal-clipboard.e2e.test.ts",
  "tests/e2e/desktop/terminal-file-drop.e2e.test.ts",
  "tests/e2e/desktop/terminal-snapshot.e2e.test.ts",
  "tests/e2e/desktop/release-alignment.e2e.test.ts",
  "tests/e2e/desktop/chat-title-layout.e2e.test.ts",
];

function buildGatedElectronSuites() {
  return readdirSync("tests/e2e/desktop").filter((file) => file.endsWith(".e2e.test.ts")).flatMap((file) => {
    const path = `tests/e2e/desktop/${file}`;
    const source = readFileSync(path, "utf8");
    const guard = source.match(/const suite = (.+?) \? describe : describe\.skip;/)?.[1];
    if (!guard) return [];
    const initializer = source.match(new RegExp(`const ${guard} = ([^;]+);`))?.[1];
    if (!(guard.includes("existsSync(") || initializer?.includes("existsSync("))) return [];
    expect(source, path).toContain("_electron");
    expect(source, path).toContain("out/main/index.js");
    return [path];
  }).sort();
}

function invoke(suite: string, failLane = "", historical = false, workers = "12") {
  const dir = mkdtempSync(resolve(tmpdir(), "matrix-benchmark-test-"));
  const bin = resolve(dir, "bin");
  const work = resolve(dir, "work");
  mkdirSync(bin);
  const fixtureScripts = { ...scripts };
  if (historical) {
    fixtureScripts.typecheck = `bun run typecheck:build-kernel && ${scripts["typecheck:run"]}`;
    delete fixtureScripts["typecheck:run"];
  }
  writeFileSync(resolve(dir, "package.json"), JSON.stringify({ scripts: fixtureScripts }));
  const executable = (name: string, source: string) => {
    writeFileSync(resolve(bin, name), `#!/bin/bash\nset -euo pipefail\n${source}\n`);
    chmodSync(resolve(bin, name), 0o755);
  };
  // Use the production script unchanged except its container-local /work path.
  const script = resolve(dir, "benchmark.sh");
  writeFileSync(script, readFileSync("scripts/ci/runner/benchmark.sh", "utf8").replaceAll("/work", work));
  executable("git", `
case "$1" in
  init) mkdir -p "$2"; cp "$HARNESS_DIR/package.json" "$2/package.json" ;;
  rev-parse) echo "$REVIEWED_SHA" ;;
esac`);
  executable("timeout", 'shift; exec "$@"');
  executable("xvfb-run", 'shift; exec "$@"');
  const barrier = `
await_peer() {
  touch "$HARNESS_DIR/$1.started"
  for ((attempt=0; attempt<100; attempt++)); do
    if [[ -f "$HARNESS_DIR/$2.started" ]]; then return 0; fi
    sleep 0.01
  done
  echo "Concurrent lane did not start" >&2
  return 90
}`;
  executable("bun", `${barrier}
printf 'bun %s\\n' "$*" >> "$CALLS"
if [[ "$2" == typecheck || "$2" == typecheck:run ]]; then
  if [[ "$REQUIRE_CONCURRENT" == 1 ]]; then await_peer checks unit; fi
  [[ "$FAIL_LANE" != checks ]] || exit 42
fi
case "$2" in
  build:shell:production)
    [[ "$FAIL_LANE" != shell ]] || exit 42
    ;;
  build:desktop)
    [[ "$FAIL_LANE" != desktop-build ]] || exit 42
    mkdir -p desktop/out/main
    touch desktop/out/main/index.js
    ;;
  typecheck)
    bash -c "$TYPECHECK_WRAPPER"
    ;;
  typecheck:build-kernel)
    bash -c "$TYPECHECK_BUILD"
    ;;
  typecheck:run)
    bash -c "$TYPECHECK_RUN"
    ;;
esac`);
  executable("pnpm", `${barrier}
printf 'pnpm %s\\n' "$*" >> "$CALLS"
if [[ "$*" == *"@matrix-os/observability"* && "$*" == *" build"* ]]; then
  echo prerequisites >> "$CALLS"
fi
if [[ "$*" == *"exec vitest run"* ]]; then
  if [[ "$*" != *"--config vitest.e2e.config.ts"* && "$*" == *"--outputFile="* ]]; then
    if [[ "$REQUIRE_CONCURRENT" == 1 ]]; then await_peer unit checks; fi
    [[ "$FAIL_LANE" != unit ]] || exit 42
  elif [[ "$*" == *"--config vitest.e2e.config.ts"* ]]; then
    if [[ "$*" != *"tests/e2e/"* || "$*" == *"--exclude="* ]]; then
      # Simulate the real describe.skip gate in the general desktop suites,
      # including suites absent from the explicit Electron regression list.
      selection=web,browser-download,shared-rail-states,chat-onboarding-live
      if [[ -f desktop/out/main/index.js ]]; then
        for name in file-download chat-picker-responsive getting-started operator hermes-conversations; do
          if [[ "$*" != *"--exclude=tests/e2e/desktop/$name.e2e.test.ts"* ]]; then selection="$selection,$name"; fi
        done
      fi
      printf 'general-selection %s\\n' "$selection" >> "$CALLS"
      [[ "$FAIL_LANE" != general ]] || exit 42
    elif [[ "$*" == *"tests/e2e/desktop/file-download.e2e.test.ts"* ]]; then
      [[ "$FAIL_LANE" != electron ]] || exit 42
    fi
  fi
fi`);
  try {
    const result = spawnSync("bash", [script, sha, suite, workers], {
      encoding: "utf8", timeout: 10_000,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: resolve(dir, "calls"),
        HARNESS_DIR: dir, REVIEWED_SHA: sha, FAIL_LANE: failLane,
        REQUIRE_CONCURRENT: suite === "full" ? "1" : "0",
        TYPECHECK_WRAPPER: fixtureScripts.typecheck,
        TYPECHECK_BUILD: fixtureScripts["typecheck:build-kernel"],
        TYPECHECK_RUN: fixtureScripts["typecheck:run"] ?? "exit 127",
      },
    });
    return {
      result, calls: readFileSync(resolve(dir, "calls"), "utf8").trim().split("\n"),
      timings: readFileSync(resolve(work, "results/timing.tsv"), "utf8").trim().split("\n").map((line) => line.split("\t")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("isolated cold and warm benchmark execution", () => {
  it("preserves hosted general selection after Desktop builds on both full passes", () => {
    const { result, calls, timings } = invoke("full");
    expect(result.status, result.stderr).toBe(0);
    const selections = calls.filter((call) => call.startsWith("general-selection "));
    expect(selections).toEqual([
      "general-selection web,browser-download,shared-rail-states,chat-onboarding-live",
      "general-selection web,browser-download,shared-rail-states,chat-onboarding-live",
    ]);
    expect(calls.filter((call) => call === "bun run build:desktop")).toHaveLength(2);
    for (const pass of ["cold", "warm"]) {
      const build = timings.findIndex(([label]) => label === `desktop-build-${pass}`);
      expect(build).toBeGreaterThan(-1);
      expect(build).toBeLessThan(timings.findIndex(([label]) => label === `e2e-general-${pass}`));
    }
  });

  it("excludes exactly the native build-gated suites and preserves every hosted Electron regression", () => {
    const { result, calls } = invoke("full");
    expect(result.status, result.stderr).toBe(0);
    const gated = buildGatedElectronSuites();
    expect(gated).toHaveLength(34);
    const general = calls.filter((call) => call.includes("--config vitest.e2e.config.ts") && call.includes("--exclude="));
    expect(general).toHaveLength(2);
    for (const call of general) {
      const excluded = Array.from(call.matchAll(/--exclude=(\S+)/g), (match) => match[1]).sort();
      expect(excluded).toEqual(gated);
    }
    const electron = calls.filter((call) => call.includes("tests/e2e/desktop/file-download.e2e.test.ts") && !call.includes("--exclude="));
    expect(electron).toHaveLength(2);
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const hosted = workflow.split("\n").filter((line) => line.includes("run: xvfb-run") && line.includes("tests/e2e/"))
      .flatMap((line) => line.match(/tests\/e2e\/\S+\.e2e\.test\.ts/g) ?? [])
      .filter((file) => !file.endsWith("terminal-soft-grid.e2e.test.ts"));
    expect(hosted).toEqual(electronSuites);
    for (const call of electron) {
      expect(call.match(/tests\/e2e\/\S+\.e2e\.test\.ts/g)).toEqual(hosted);
      expect(call).not.toContain("operator.e2e.test.ts");
      expect(call).not.toContain("hermes-conversations.e2e.test.ts");
    }
  });

  it.each(["e2e", "e2e-general"])("%s preserves the same general scope without building Desktop", (suite) => {
    const { result, calls } = invoke(suite);
    expect(result.status, result.stderr).toBe(0);
    expect(calls.filter((call) => call === "bun run build:desktop")).toHaveLength(0);
    const general = calls.filter((call) => call.includes("--exclude="));
    expect(general).toHaveLength(2);
    for (const call of general)
      expect(Array.from(call.matchAll(/--exclude=(\S+)/g), (match) => match[1]).sort()).toEqual(buildGatedElectronSuites());
  });

  it("keeps standalone Electron builds and every explicit Electron regression", () => {
    const { result, calls, timings } = invoke("e2e-electron");
    expect(result.status, result.stderr).toBe(0);
    expect(calls.filter((call) => call === "bun run build:desktop")).toHaveLength(2);
    const electron = calls.filter((call) => call.includes("tests/e2e/desktop/file-download.e2e.test.ts"));
    expect(electron).toHaveLength(2);
    for (const call of electron) {
      for (const file of electronSuites) expect(call).toContain(file);
    }
    expect(timings.filter(([label]) => label.startsWith("terminal-grid-"))).toHaveLength(2);
  });

  it.each(["typecheck", "checks", "full"])("%s reuses prerequisites for both no-emit passes", (suite) => {
    const { result, calls } = invoke(suite);
    expect(result.status, result.stderr).toBe(0);
    expect(calls.filter((call) => call === "prerequisites")).toHaveLength(1);
    expect(calls.filter((call) => call === "bun run typecheck:run")).toHaveLength(2);
    expect(calls.filter((call) => call.includes(" exec tsc --noEmit"))).toHaveLength(12);
    expect(calls.filter((call) => call === "pnpm --filter desktop run typecheck")).toHaveLength(2);
  });

  it.each(["typecheck", "checks", "full"])("historical %s preserves its original typecheck wrapper and every check", (suite) => {
    const { result, calls } = invoke(suite, "", true);
    expect(result.status, result.stderr).toBe(0);
    expect(calls.filter((call) => call === "bun run typecheck:run")).toHaveLength(0);
    expect(calls.filter((call) => call === "bun run typecheck")).toHaveLength(2);
    expect(calls.filter((call) => call === "prerequisites")).toHaveLength(3);
    expect(calls.filter((call) => call.includes(" exec tsc --noEmit"))).toHaveLength(12);
    expect(calls.filter((call) => call === "pnpm --filter desktop run typecheck")).toHaveLength(2);
  });

  it("preserves the developer typecheck prerequisite wrapper and every check", () => {
    expect(scripts.typecheck).toBe("bun run typecheck:build-kernel && bun run typecheck:run");
    expect(scripts["typecheck:run"]).toBe([
      "pnpm --filter '@matrix-os/observability' exec tsc --noEmit",
      "pnpm --filter '@matrix-os/integrations-mcp' exec tsc --noEmit",
      "pnpm --filter '@matrix-os/gateway' exec tsc --noEmit",
      "pnpm --filter '@matrix-os/platform' exec tsc --noEmit -p tsconfig.typecheck.json",
      "pnpm --filter '@matrix-os/proxy' exec tsc --noEmit",
      "pnpm --filter '@matrix-os/edge-router' exec tsc --noEmit",
      "pnpm --filter desktop run typecheck",
    ].join(" && "));
  });

  it.each(["unit", "shell", "general", "electron", "desktop-build"])("propagates full %s failures after collecting both concurrent passes", (lane) => {
    const { result, timings } = invoke("full", lane);
    expect(result.status, result.stderr).toBe(1);
    for (const pass of ["cold", "warm"]) {
      expect(timings).toContainEqual([`${lane === "general" ? "e2e-general" : lane === "electron" ? "e2e-electron" : lane}-${pass}`, expect.any(String), "42"]);
      for (const label of ["unit", "typecheck", "shell", "e2e-general", "e2e-electron"])
        expect(timings.some(([record]) => record === `${label}-${pass}`)).toBe(true);
    }
  });

  it("preserves diagnostic typecheck failures as nonblocking in the full checks lane", () => {
    const { result, timings } = invoke("full", "checks");
    expect(result.status, result.stderr).toBe(0);
    for (const pass of ["cold", "warm"])
      expect(timings).toContainEqual([`typecheck-${pass}`, expect.any(String), "42"]);
  });
});

describe("eight-core full benchmark budget", () => {
  it("uses four unit workers alongside checks and browser lanes", () => {
    const { result, calls } = invoke("full", "", false, "8");
    expect(result.status).toBe(0);
    expect(calls.some((call) => call.includes("--maxWorkers=4 --reporter=default"))).toBe(true);
    expect(calls.some((call) => call.includes("--maxWorkers=12"))).toBe(false);
  });
});
