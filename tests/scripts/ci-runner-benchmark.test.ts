import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const clipboardSuite = "tests/e2e/desktop/terminal-clipboard.e2e.test.ts";

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

function invoke(suite: string, failLane = "", historical = false, workers = "12", prepared: "none" | "match" | "mismatch" = "none") {
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), "matrix-benchmark-test-")));
  const bin = resolve(dir, "bin");
  const work = resolve(dir, "work");
  mkdirSync(bin);
  writeFileSync(resolve(dir,"pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const preparedDir=resolve(dir,"prepared");
  mkdirSync(preparedDir);
  const fixtureInitdb = resolve(dir,"fixture-initdb");
  writeFileSync(fixtureInitdb,"#!/bin/bash\nexit 0\n");
  chmodSync(fixtureInitdb,0o755);
  writeFileSync(resolve(preparedDir,"fixture-postgres.sh"),"start_fixture_postgres() { echo fixture-start >> \"$CALLS\"; }\nstop_fixture_postgres() { echo fixture-stop >> \"$CALLS\"; }\n");
  if(prepared !== "none") { mkdirSync(resolve(preparedDir,"browsers")); mkdirSync(resolve(preparedDir,"pnpm-store"));
    writeFileSync(resolve(preparedDir,"prepared-lock.sha256"), prepared === "match" ? createHash("sha256").update("lockfileVersion: '9.0'\n").digest("hex") : "0".repeat(64));
  }
  writeFileSync(resolve(dir, "displays"), "");
  const fixtureScripts = { ...scripts, "typecheck:run": "printf 'native typecheck mocked\\n'" };
  if (historical) {
    fixtureScripts.typecheck = `bun run typecheck:build-kernel && ${fixtureScripts["typecheck:run"]}`;
    delete fixtureScripts["typecheck:run"];
  }
  writeFileSync(resolve(dir, "package.json"), JSON.stringify({ scripts: fixtureScripts }));
  writeFileSync(resolve(dir, "qualification-coverage.mjs"), readFileSync("scripts/ci/qualification-coverage.mjs", "utf8"));
  const parityMinimums = [
    ["tests/repository/site-extraction.test.ts",2], ["tests/contracts/os-view.test.ts",12],
    ["tests/shell/desktop-mode-parity.test.ts",3], ["tests/shell/desktop-launcher-mode.test.tsx",21],
    ["tests/shell/web-desktop-surface.test.tsx",10], ["tests/shell/os-view-state-client.test.ts",6],
    ["tests/desktop/app-launcher.test.tsx",13], ["tests/desktop/native-desktop-shell.test.tsx",47],
    ["tests/desktop/os-view-state-client.test.ts",4], ["tests/desktop/native-os-view-persistence.test.ts",4],
    ["tests/gateway/os-view-state-repository.test.ts",12],
  ] as const;
  const report = {success:true,numFailedTests:0,testResults:parityMinimums.map(([path,count])=>({
    name:resolve(work,"repo",path),status:"passed",assertionResults:Array.from({length:count},()=>({status:"passed"})),
  }))};
  if(failLane === "coverage-skipped") report.testResults[0].assertionResults[0].status="skipped";
  if(failLane === "coverage-duplicate") report.testResults.push(report.testResults[0]);
  if(failLane === "coverage-under-count") report.testResults[0].assertionResults.pop();
  writeFileSync(resolve(dir,"unit-report.json"),JSON.stringify(report));
  const executable = (name: string, source: string) => {
    writeFileSync(resolve(bin, name), `#!/bin/bash\nset -euo pipefail\n${source}\n`);
    chmodSync(resolve(bin, name), 0o755);
  };
  // Use the production script unchanged except its container-local /work path.
  const script = resolve(dir, "benchmark.sh");
  writeFileSync(script, readFileSync("scripts/ci/runner/benchmark.sh", "utf8").replaceAll("/work", work).replaceAll("/opt/matrix-ci", preparedDir).replaceAll("/usr/lib/postgresql/16/bin/initdb",fixtureInitdb));
  executable("git", `
case "$1" in
  init) mkdir -p "$2/scripts/ci"; cp "$HARNESS_DIR/qualification-coverage.mjs" "$2/scripts/ci/qualification-coverage.mjs"; cp "$HARNESS_DIR/package.json" "$2/package.json"; cp "$HARNESS_DIR/pnpm-lock.yaml" "$2/pnpm-lock.yaml" ;;
  rev-parse) echo "$REVIEWED_SHA" ;;
esac`);
  executable("timeout", 'shift; exec "$@"');
  executable("node", 'if [[ "$1" == scripts/ci/qualification-coverage.mjs ]]; then printf "node %s\\n" "$*" >> "$CALLS"; fi; exec "$REAL_NODE" "$@"');
  executable("xvfb-run", 'printf "%s\\n" "$*" >> "$DISPLAYS"; shift; exec "$@"');
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
    if [[ "$REQUIRE_CONCURRENT" == 1 ]]; then await_peer desktop general; fi
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
    printf 'profile-sort %s\\n' "\${MATRIX_TEST_PROFILE_SORT:-0}" >> "$CALLS"
    [[ "$FAIL_LANE" != unit ]] || exit 42
    for argument in "$@"; do
      if [[ "$argument" == --outputFile=* && "$FAIL_LANE" != coverage-missing ]]; then
        cp "$HARNESS_DIR/unit-report.json" "\${argument#--outputFile=}"
      fi
    done
  elif [[ "$*" == *"--config vitest.e2e.config.ts"* ]]; then
    if [[ "$*" != *"tests/e2e/"* || "$*" == *"--exclude="* ]]; then
      # Simulate the real describe.skip gate in the general desktop suites,
      # including suites absent from the explicit Electron regression list.
      if [[ "$REQUIRE_CONCURRENT" == 1 ]]; then await_peer general desktop; fi
      selection=web,browser-download,shared-rail-states,chat-onboarding-live
      if [[ -f desktop/out/main/index.js ]]; then
        for name in file-download chat-picker-responsive getting-started operator hermes-conversations; do
          if [[ "$*" != *"--exclude=tests/e2e/desktop/$name.e2e.test.ts"* ]]; then selection="$selection,$name"; fi
        done
      fi
      printf 'general-selection %s\\n' "$selection" >> "$CALLS"
      [[ "$FAIL_LANE" != general ]] || exit 42
    else
      if [[ "$*" == *"tests/e2e/desktop/terminal-clipboard.e2e.test.ts"* ]]; then
        [[ "$FAIL_LANE" != clipboard ]] || exit 42
      fi
      if [[ "$*" == *"tests/e2e/desktop/file-download.e2e.test.ts"* ]]; then
        [[ "$FAIL_LANE" != electron ]] || exit 42
      fi
    fi
  fi
fi`);
  try {
    const result = spawnSync("bash", [script, sha, suite, workers], {
      encoding: "utf8", timeout: 10_000,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: resolve(dir, "calls"),
        HARNESS_DIR: dir, REVIEWED_SHA: sha, FAIL_LANE: failLane, MATRIX_TEST_PROFILE_SORT: "0", REAL_NODE: process.execPath,
        DISPLAYS: resolve(dir, "displays"),
        REQUIRE_CONCURRENT: ["full", "qualification"].includes(suite) ? "1" : "0",
        TYPECHECK_WRAPPER: fixtureScripts.typecheck,
        TYPECHECK_BUILD: fixtureScripts["typecheck:build-kernel"],
        TYPECHECK_RUN: fixtureScripts["typecheck:run"] ?? "exit 127",
      },
    });
    return {
      result, calls: readFileSync(resolve(dir, "calls"), "utf8").trim().split("\n"),
      displays: readFileSync(resolve(dir, "displays"), "utf8").trim().split("\n").filter(Boolean),
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
      expect(build).toBeLessThan(timings.findIndex(([label]) => label === `terminal-grid-${pass}`));
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
    const clipboard = calls.filter((call) => call.includes(clipboardSuite) && !call.includes("--exclude="));
    expect(clipboard).toHaveLength(2);
    for (const [index, call] of electron.entries()) {
      const files = [call, clipboard[index]].flatMap(command => command.match(/tests\/e2e\/\S+\.e2e\.test\.ts/g) ?? []);
      expect(files.sort()).toEqual([...hosted].sort());
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
    const clipboard = calls.filter((call) => call.includes(clipboardSuite));
    for (const [index, call] of electron.entries()) {
      const files = [call, clipboard[index]].flatMap(command => command.match(/tests\/e2e\/\S+\.e2e\.test\.ts/g) ?? []);
      expect(files.sort()).toEqual([...electronSuites].sort());
    }
    expect(timings.filter(([label]) => label.startsWith("terminal-grid-"))).toHaveLength(2);
  });

  it.each(["full", "e2e-electron"])("%s gives clipboard its own single-file display on both passes", suite => {
    const { result, displays, timings } = invoke(suite);
    expect(result.status, result.stderr).toBe(0);
    const clipboard = displays.filter(call => call.includes(clipboardSuite) && !call.includes("--exclude="));
    const common = displays.filter(call => call.includes(electronSuites[0]) && !call.includes("--exclude="));
    expect(clipboard).toHaveLength(2); expect(common).toHaveLength(2);
    for (const [index, pass] of ["cold", "warm"].entries()) {
      expect(clipboard[index]).toContain("--auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts --maxWorkers=1");
      expect(clipboard[index].match(/tests\/e2e\/\S+\.e2e\.test\.ts/g)).toEqual([clipboardSuite]);
      expect(common[index]).toContain("--maxWorkers=2");
      expect(common[index]).not.toContain(clipboardSuite);
      const files = [common[index], clipboard[index]].flatMap(call => call.match(/tests\/e2e\/\S+\.e2e\.test\.ts/g) ?? []);
      expect(files.sort()).toEqual([...electronSuites].sort());
      const commonTiming = timings.findIndex(([label]) => label === `e2e-electron-${pass}`);
      const clipboardTiming = timings.findIndex(([label]) => label === `e2e-clipboard-${pass}`);
      expect(clipboardTiming).toBeGreaterThan(commonTiming);
      expect(timings[clipboardTiming]).toEqual([`e2e-clipboard-${pass}`, expect.any(String), "0"]);
    }
  });

  it("propagates standalone clipboard failures while preserving both complete Electron passes", () => {
    const { result, timings } = invoke("e2e-electron", "clipboard");
    expect(result.status, result.stderr).toBe(1);
    for (const pass of ["cold", "warm"]) {
      expect(timings).toContainEqual([`e2e-clipboard-${pass}`, expect.any(String), "42"]);
      for (const lane of ["desktop-build", "terminal-grid", "e2e-electron"])
        expect(timings).toContainEqual([`${lane}-${pass}`, expect.any(String), "0"]);
    }
  });

  it.each(["typecheck", "checks", "full"])("%s reuses prerequisites for both no-emit passes", (suite) => {
    const { result, calls, timings } = invoke(suite);
    expect(result.status, result.stderr).toBe(0);
    expect(calls.filter((call) => call === "prerequisites")).toHaveLength(1);
    expect(calls.filter((call) => call === "bun run typecheck:run")).toHaveLength(2);
    expect(timings.filter(([label]) => label.startsWith("typecheck-"))).toHaveLength(2);
  });

  it.each(["typecheck", "checks", "full"])("historical %s preserves its original typecheck wrapper and every check", (suite) => {
    const { result, calls, timings } = invoke(suite, "", true);
    expect(result.status, result.stderr).toBe(0);
    expect(calls.filter((call) => call === "bun run typecheck:run")).toHaveLength(0);
    expect(calls.filter((call) => call === "bun run typecheck")).toHaveLength(2);
    expect(calls.filter((call) => call === "prerequisites")).toHaveLength(3);
    expect(timings.filter(([label]) => label.startsWith("typecheck-"))).toHaveLength(2);
  });

  it("preserves the developer typecheck prerequisite wrapper and every check", () => {
    expect(scripts.typecheck).toBe("bun run typecheck:build-kernel && bun run typecheck:run");
    expect(scripts["typecheck:run"]).toBe("node scripts/typecheck.mjs");
  });

  it.each(["unit", "shell", "general", "electron", "clipboard", "desktop-build"])("propagates full %s failures after collecting both concurrent passes", (lane) => {
    const { result, timings } = invoke("full", lane);
    expect(result.status, result.stderr).toBe(1);
    for (const pass of ["cold", "warm"]) {
      expect(timings).toContainEqual([`${lane === "general" ? "e2e-general" : lane === "electron" ? "e2e-electron" : lane === "clipboard" ? "e2e-clipboard" : lane}-${pass}`, expect.any(String), "42"]);
      for (const label of ["unit", "typecheck", "shell", "e2e-general", "e2e-electron", "e2e-clipboard", "terminal-grid"])
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

 describe("single-pass Linux qualification", () => {
  it("models Linux PostgreSQL admission and cleanup in the mocked qualification",()=>{
    const {result,calls}=invoke("qualification");
    expect(result.status,result.stderr).toBe(0);
    expect(calls.filter(call=>call === "fixture-start")).toHaveLength(1);
    expect(calls.filter(call=>call === "fixture-stop")).toHaveLength(1);
  });
  it("enables measured profile ordering only for qualification",()=>{
    const qualified=invoke("qualification");
    expect(qualified.result.status,qualified.result.stderr).toBe(0);
    expect(qualified.calls).toContain("profile-sort 1");
    const historical=invoke("full");
    expect(historical.result.status,historical.result.stderr).toBe(0);
    expect(historical.calls.filter(call=>call === "profile-sort 0")).toHaveLength(2);
  });
  it("proves the unit-collected parity once while historical full keeps both dedicated parity runs",()=>{
    const qualified=invoke("qualification");
    expect(qualified.result.status,qualified.result.stderr).toBe(0);
    expect(qualified.calls.filter(call=>call.startsWith("node scripts/ci/qualification-coverage.mjs "))).toHaveLength(1);
    expect(qualified.calls.some(call=>call.startsWith("pnpm exec vitest run --maxWorkers=2 tests/repository/site-extraction.test.ts"))).toBe(false);
    expect(qualified.timings).toContainEqual(["docs-parity-proof-cold",expect.any(String),"0"]);
    const historical=invoke("full");
    expect(historical.result.status,historical.result.stderr).toBe(0);
    expect(historical.calls.filter(call=>call.startsWith("pnpm exec vitest run --maxWorkers=2 tests/repository/site-extraction.test.ts"))).toHaveLength(2);
    expect(historical.calls.some(call=>call.startsWith("node scripts/ci/qualification-coverage.mjs "))).toBe(false);
  });
  it.each(["coverage-missing","coverage-skipped","coverage-duplicate","coverage-under-count"])("rejects %s unit coverage after collecting every required lane",fail=>{
    const {result,timings}=invoke("qualification",fail);
    expect(result.status,result.stderr).toBe(1);
    expect(timings).toContainEqual(["docs-parity-proof-cold",expect.any(String),"1"]);
    for(const lane of ["unit","shell","e2e-general","e2e-electron","e2e-clipboard","terminal-grid"])
      expect(timings.some(([label])=>label === `${lane}-cold`)).toBe(true);
  });
  it("runs every full lane once and fails when any required lane fails", () => {
    for (const fail of ["", "unit", "checks", "shell", "general", "electron", "clipboard", "desktop-build"]) {
      const {result,calls,timings} = invoke("qualification", fail);
      expect(result.status, result.stderr).toBe(fail ? 1 : 0);
      for (const lane of ["unit", "typecheck", "shell", "e2e-general", "e2e-electron", "e2e-clipboard", "terminal-grid"])
        expect(timings.filter(([label]) => label === `${lane}-cold`)).toHaveLength(1);
      expect(timings.some(([label]) => label.endsWith("-warm"))).toBe(false);
      expect(calls.filter(call => call === "bun run build:desktop")).toHaveLength(1);
    }
  });
 });

describe("readonly prepared dependency admission",()=> {
  it.each(["match","mismatch"] as const)("uses image browser cache only for %s lockfile", prepared=> {
    const {result,calls,timings}=invoke("qualification","",false,"12",prepared);
    expect(result.status,result.stderr).toBe(0);
    expect(calls.filter(call=>call==="pnpm install --frozen-lockfile")).toHaveLength(1);
    const browserInstalls=calls.filter(call=>call.includes("playwright install chromium"));
    expect(browserInstalls).toHaveLength(prepared === "match" ? 0 : 2);
    expect(timings.some(([label])=>label==="prepared-store")).toBe(prepared === "match");
    expect(timings.some(([label])=>label==="prepared-browsers")).toBe(prepared === "match");
  });
});

describe("bare-metal qualification worker budget",()=>{
  it("uses sixteen requested unit workers while preserving separate bounded lanes",()=>{
    const {result,calls}=invoke("qualification","",false,"16");
    expect(result.status,result.stderr).toBe(0);
    expect(calls.filter(call=>call.includes("--maxWorkers=16 --reporter=default"))).toHaveLength(1);
    expect(calls.some(call=>call.includes("--config vitest.e2e.config.ts --maxWorkers=2"))).toBe(true);
  });
});
