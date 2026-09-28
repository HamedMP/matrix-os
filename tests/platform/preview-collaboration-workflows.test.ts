import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = { name?: string; run?: string; uses?: string };
type Job = { if?: string; needs?: string | string[]; environment?: string; env?: Record<string, string>; steps: Step[]; outputs?: Record<string, string> };
const vpsWorkflowText = readFileSync(".github/workflows/preview-vps.yml", "utf8");
const vpsWorkflow = YAML.parse(vpsWorkflowText) as { concurrency: { group: string }; jobs: Record<string, Job> };
const platformWorkflowText = readFileSync(".github/workflows/preview-platform.yml", "utf8");
const platformWorkflow = YAML.parse(platformWorkflowText) as {
  on: { workflow_dispatch: { inputs: Record<string, { type: string; default: unknown }> } };
  jobs: Record<string, Job>;
};

function stepRun(job: Job, name: string): string {
  const run = job.steps.find((step) => step.name === name)?.run;
  expect(typeof run, name).toBe("string");
  return run as string;
}

function executable(directory: string, name: string, body: string) {
  const path = join(directory, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`);
  chmodSync(path, 0o755);
}

const OWNER = "user_collaborationowner";
const PREVIEW_OWNER = "user_previewowner";
const HANDLE = "pr-1990";
const MACHINE = "3f6b1a2c-4d5e-4f60-8a7b-9c0d1e2f3a4b";

describe("preview VPS collaboration owner", () => {
  const gate = vpsWorkflow.jobs.gate!;
  const decide = stepRun(gate, "Decide action");

  function decideAction(env: Record<string, string>, pullRequest?: unknown) {
    const directory = mkdtempSync(join(tmpdir(), "preview-collaboration-gate-"));
    try {
      const output = join(directory, "output");
      writeFileSync(output, "");
      executable(directory, "gh", `printf '%s' "$PULL_REQUEST"\n`);
      const result = spawnSync("bash", ["-euc", decide], { encoding: "utf8", timeout: 5_000, env: {
        PATH: `${directory}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "HamedMP/matrix-os",
        GITHUB_REF: "refs/heads/main", PR_NUMBER: "1990", EVENT_HEAD_SHA: "a".repeat(40), EVENT_HEAD_REF: "feature",
        EVENT_HEAD_REPO: "HamedMP/matrix-os", HAS_LABEL: "false", HAS_COLLABORATION_LABEL: "false",
        LABELED_NAME: "", REQUESTED_VERSION: "", VERIFY_INVENTORY: "false", TEARDOWN_PREVIEW: "false",
        PULL_REQUEST: JSON.stringify(pullRequest ?? {}), ...env,
      } });
      expect(result.status, result.stderr).toBe(0);
      return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=", 2)));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  it("marks a preview-vps PR that also carries preview-collaboration as a collaboration preview", () => {
    expect(gate.outputs?.collaboration).toBe("${{ steps.decide.outputs.collaboration }}");
    expect(decideAction({ EVENT_NAME: "pull_request", EVENT_ACTION: "synchronize", HAS_LABEL: "true", HAS_COLLABORATION_LABEL: "true" }))
      .toMatchObject({ action: "deploy", collaboration: "true" });
    expect(decideAction({ EVENT_NAME: "pull_request", EVENT_ACTION: "labeled", LABELED_NAME: "preview-collaboration", HAS_LABEL: "true", HAS_COLLABORATION_LABEL: "true" }))
      .toMatchObject({ action: "deploy", collaboration: "true" });
    expect(decideAction({ EVENT_NAME: "workflow_dispatch", EVENT_ACTION: "", EVENT_HEAD_SHA: "", EVENT_HEAD_REF: "", EVENT_HEAD_REPO: "" }, {
      head: { sha: "b".repeat(40), ref: "feature", repo: { full_name: "HamedMP/matrix-os" } },
      labels: [{ name: "preview-vps" }, { name: "preview-collaboration" }],
    })).toMatchObject({ action: "deploy", collaboration: "true" });
  });

  it("leaves previews without the label, and collaboration labels without preview-vps, unchanged", () => {
    expect(decideAction({ EVENT_NAME: "pull_request", EVENT_ACTION: "synchronize", HAS_LABEL: "true" }))
      .toMatchObject({ action: "deploy", collaboration: "false" });
    // A manual dispatch still needs both labels before it releases the collaboration owner.
    expect(decideAction({ EVENT_NAME: "workflow_dispatch", EVENT_ACTION: "", EVENT_HEAD_SHA: "", EVENT_HEAD_REF: "", EVENT_HEAD_REPO: "" }, {
      head: { sha: "b".repeat(40), ref: "feature", repo: { full_name: "HamedMP/matrix-os" } },
      labels: [{ name: "preview-collaboration" }],
    })).toMatchObject({ action: "deploy", collaboration: "false" });
    expect(decideAction({ EVENT_NAME: "pull_request", EVENT_ACTION: "labeled", LABELED_NAME: "preview-collaboration", HAS_COLLABORATION_LABEL: "true" }))
      .toMatchObject({ action: "skip" });
    expect(decideAction({ EVENT_NAME: "pull_request", EVENT_ACTION: "labeled", LABELED_NAME: "preview-collaboration", HAS_LABEL: "true", HAS_COLLABORATION_LABEL: "true", EVENT_HEAD_REPO: "someone/fork" }))
      .toMatchObject({ action: "skip" });
    expect(vpsWorkflow.concurrency.group).toContain("github.event.label.name != 'preview-collaboration'");
  });

  it("releases the collaboration owner only through the protected environment", () => {
    const deploy = vpsWorkflow.jobs.deploy!;
    expect(deploy.environment).toBe("${{ needs.gate.outputs.collaboration == 'true' && 'collaboration-e2e' || '' }}");
    expect(deploy.env?.PREVIEW_COLLABORATION).toBe("${{ needs.gate.outputs.collaboration }}");
    expect(deploy.env?.PREVIEW_COLLABORATION_OWNER_USER_ID)
      .toBe("${{ needs.gate.outputs.collaboration == 'true' && secrets.PREVIEW_COLLABORATION_OWNER_USER_ID || '' }}");
    expect(vpsWorkflowText.match(/PREVIEW_COLLABORATION_OWNER_USER_ID: \$\{\{/g)).toHaveLength(1);
  });

  const provision = stepRun(vpsWorkflow.jobs.deploy!, "Provision or resume preview VPS");

  function runProvision(env: Record<string, string>, existing?: { clerkUserId: string; status: string }) {
    const directory = mkdtempSync(join(tmpdir(), "preview-collaboration-provision-"));
    try {
      const capture = join(directory, "provision-body");
      const fleetBefore = { machines: existing ? [{ machineId: MACHINE, handle: HANDLE, runtimeSlot: HANDLE, deletedAt: null, ...existing }] : [] };
      const fleetAfter = { machines: [{ machineId: MACHINE, handle: HANDLE, runtimeSlot: HANDLE, deletedAt: null, status: "running", clerkUserId: "any" }] };
      executable(directory, "curl", `out=""; write=""; data=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) write="$2"; shift 2 ;;
    --data-binary) data="$2"; shift 2 ;;
    -H|-X|--max-time) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */vps/fleet) if [ -f "$STATE" ]; then body="$FLEET_AFTER"; else body="$FLEET_BEFORE"; fi ;;
  */vps/preview/provision) printf '%s' "$data" > "$CAPTURE"; : > "$STATE"; body='{"machineId":"${MACHINE}","status":"running","etaSeconds":0}' ;;
  *) exit 22 ;;
esac
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
if [ -n "$write" ]; then printf '202'; fi
`);
      const script = provision.replaceAll("/tmp/provision.json", join(directory, "provision.json"));
      const result = spawnSync("bash", ["-euc", script], { encoding: "utf8", timeout: 10_000, env: {
        PATH: `${directory}:${process.env.PATH}`, PLATFORM_PUBLIC_URL: "https://platform.example.test", PLATFORM_SECRET: "synthetic",
        HANDLE, VERSION: "v2026.09.28-pr1990-1-1-aaaaaaa", PREVIEW_CLERK_USER_ID: PREVIEW_OWNER,
        PREVIEW_CLERK_ACCESS_USER_IDS: JSON.stringify(["user_collaboratorone"]), PREVIEW_COLLABORATION: "false",
        PREVIEW_COLLABORATION_OWNER_USER_ID: "", CAPTURE: capture, STATE: join(directory, "provisioned"),
        FLEET_BEFORE: JSON.stringify(fleetBefore), FLEET_AFTER: JSON.stringify(fleetAfter), ...env,
      } });
      return { ...result, body: existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")) : undefined };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  it("provisions without the label exactly as before", () => {
    const result = runProvision({});
    expect(result.status, result.stderr).toBe(0);
    expect(result.body).toMatchObject({ clerkUserId: PREVIEW_OWNER, accessClerkUserIds: ["user_collaboratorone"], handle: HANDLE, runtimeSlot: HANDLE });
  });

  it("provisions a collaboration preview under the collaboration owner with an empty access list", () => {
    const result = runProvision({ PREVIEW_COLLABORATION: "true", PREVIEW_COLLABORATION_OWNER_USER_ID: OWNER });
    expect(result.status, result.stderr).toBe(0);
    expect(result.body).toMatchObject({ clerkUserId: OWNER, accessClerkUserIds: [], handle: HANDLE, runtimeSlot: HANDLE });
    expect(`${result.stdout}${result.stderr}`).not.toContain(OWNER);
  });

  it.each([
    ["the owner is unavailable", { PREVIEW_COLLABORATION: "true", PREVIEW_COLLABORATION_OWNER_USER_ID: "" }, undefined],
    ["the owner is the repository preview owner", { PREVIEW_COLLABORATION: "true", PREVIEW_COLLABORATION_OWNER_USER_ID: PREVIEW_OWNER }, undefined],
    ["the owner is malformed", { PREVIEW_COLLABORATION: "true", PREVIEW_COLLABORATION_OWNER_USER_ID: "user_bad id" }, undefined],
    ["pr-<N> belongs to the repository preview owner", { PREVIEW_COLLABORATION: "true", PREVIEW_COLLABORATION_OWNER_USER_ID: OWNER }, { clerkUserId: PREVIEW_OWNER, status: "running" }],
    ["pr-<N> belongs to the collaboration owner", {}, { clerkUserId: OWNER, status: "running" }],
    ["a failed pr-<N> belongs to someone else", {}, { clerkUserId: OWNER, status: "failed" }],
    ["the environment points the operator API at the preview host", { PREVIEW_COLLABORATION: "true", PREVIEW_COLLABORATION_OWNER_USER_ID: OWNER, PLATFORM_PUBLIC_URL: "https://preview.matrix-os.com/" }, undefined],
  ])("refuses to provision when %s", (_label, env, existing) => {
    const result = runProvision(env, existing);
    expect(result.status).not.toBe(0);
    expect(result.body).toBeUndefined();
    expect(`${result.stdout}${result.stderr}`).not.toContain(OWNER);
  });

  it("tells the operator to tear down a preview owned by someone else", () => {
    const result = runProvision({ PREVIEW_COLLABORATION: "true", PREVIEW_COLLABORATION_OWNER_USER_ID: OWNER }, { clerkUserId: PREVIEW_OWNER, status: "running" });
    expect(result.stderr).toContain("teardown_preview");
  });
});

describe("preview platform collaboration home connection", () => {
  const jobs = platformWorkflow.jobs;
  const connect = jobs["connect-collaboration-preview"]!;

  it("adds an opt-in input that runs only together with connect_share_preview", () => {
    expect(platformWorkflow.on.workflow_dispatch.inputs.connect_collaboration_preview).toMatchObject({ type: "boolean", default: false });
    expect(connect.if).toBe("github.event_name == 'workflow_dispatch' && inputs.connect_share_preview && inputs.connect_collaboration_preview");
    expect(connect.needs).toBe("select-share-preview");
    expect(connect.env?.EXPECTED_HEAD_SHA).toBe("${{ needs.select-share-preview.outputs.head_sha }}");
    expect(jobs["connect-share-preview"]!.if)
      .toBe("github.event_name == 'workflow_dispatch' && inputs.connect_share_preview && !inputs.connect_collaboration_preview");
    const validation = stepRun(jobs.preview!, "Check preview configuration");
    const refused = spawnSync("bash", ["-euc", validation], { encoding: "utf8", timeout: 5_000, env: {
      PATH: process.env.PATH, GITHUB_OUTPUT: "/dev/null", CONNECT_COLLABORATION_PREVIEW: "true",
      CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview", CLOUD_RUN_SERVICE_ACCOUNT: "runner",
    } });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("connect_share_preview");
  });

  it("reads the owner and its Clerk key only from the protected environment", () => {
    expect(connect.environment).toBe("collaboration-e2e");
    expect(connect.env?.PREVIEW_COLLABORATION_OWNER_USER_ID).toBe("${{ secrets.PREVIEW_COLLABORATION_OWNER_USER_ID }}");
    expect(connect.env?.CLERK_SECRET_KEY).toBe("${{ secrets.CLERK_SECRET_KEY }}");
    const connectText = JSON.stringify(connect);
    expect(connectText).not.toContain("PREVIEW_CLERK_ACCESS_USER_IDS");
    expect(connectText).not.toContain("secrets.PLATFORM_SECRET");
    expect(platformWorkflowText.match(/PREVIEW_COLLABORATION_OWNER_USER_ID: \$\{\{/g)).toHaveLength(1);
    for (const step of connect.steps) {
      if (!step.run) continue;
      const parsed = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
      expect(parsed.status, `${step.name}: ${parsed.stderr}`).toBe(0);
    }
  });

  const check = stepRun(connect, "Check collaboration preview request");

  function checkRequest(env: Record<string, string>, pullRequest: Record<string, unknown>) {
    const directory = mkdtempSync(join(tmpdir(), "preview-collaboration-check-"));
    try {
      executable(directory, "gh", `printf '%s' "$PULL_REQUEST"\n`);
      return spawnSync("bash", ["-euc", check], { encoding: "utf8", timeout: 5_000, env: {
        PATH: `${directory}:${process.env.PATH}`, GITHUB_REPOSITORY: "HamedMP/matrix-os", PR_NUMBER: "1990",
        GCP_PROJECT_ID: "project", GCP_REGION: "region", CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview",
        ARTIFACT_REPOSITORY: "repository", PREVIEW_CLERK_USER_ID: PREVIEW_OWNER, PREVIEW_COLLABORATION_OWNER_USER_ID: OWNER,
        CLERK_SECRET_KEY: "sk_synthetic", EXPECTED_HEAD_SHA: "c".repeat(40), ...env,
        PULL_REQUEST: JSON.stringify({
          state: "open", head: { sha: "c".repeat(40), repo: { full_name: "HamedMP/matrix-os" } },
          labels: [{ name: "preview-vps" }, { name: "preview-collaboration" }], ...pullRequest,
        }),
      } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  it("accepts only an open same-repository PR at the selected head with both labels", () => {
    expect(checkRequest({}, {}).status).toBe(0);
    for (const [env, pullRequest] of [
      [{ PREVIEW_COLLABORATION_OWNER_USER_ID: PREVIEW_OWNER }, {}],
      [{ PREVIEW_COLLABORATION_OWNER_USER_ID: "" }, {}],
      [{ CLERK_SECRET_KEY: "" }, {}],
      [{ CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform" }, {}],
      [{ PR_NUMBER: "1990;x" }, {}],
      [{}, { labels: [{ name: "preview-vps" }] }],
      [{}, { labels: [{ name: "preview-collaboration" }] }],
      [{}, { state: "closed" }],
      [{}, { head: { sha: "d".repeat(40), repo: { full_name: "HamedMP/matrix-os" } } }],
      [{}, { head: { sha: "c".repeat(40), repo: { full_name: "someone/fork" } } }],
    ] as const) {
      const result = checkRequest(env, pullRequest);
      expect(result.status, JSON.stringify([env, pullRequest])).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(OWNER);
    }
  });

  const connectStep = stepRun(connect, "Connect the disposable home to the preview authority");

  type Scenario = {
    session?: boolean;
    identity?: boolean;
    register?: boolean;
    claim?: boolean;
    apply?: boolean;
    arm?: boolean;
    healthy?: boolean;
    restarted?: boolean;
    enrolled?: boolean;
  };

  function runConnect(scenario: Scenario) {
    const directory = mkdtempSync(join(tmpdir(), "preview-collaboration-connect-"));
    try {
      const log = join(directory, "log");
      writeFileSync(log, "");
      mkdirSync(join(directory, "bin"));
      symlinkSync(resolve("scripts"), join(directory, "scripts"));
      writeFileSync(join(directory, "preview-share-route.json"), JSON.stringify({ address: "203.0.113.7", handle: HANDLE }));
      const bin = join(directory, "bin");
      executable(bin, "sleep", ":\n");
      executable(bin, "gcloud", `printf 'gcloud %s\\n' "$3 $4" >> "$LOG"; printf 'synthetic-secret-value'\n`);
      executable(bin, "node", `case "$*" in
  *"preview-collaboration-staging.mjs register"*) printf 'register\\n' >> "$LOG"; [ "$REGISTER" = true ] ;;
  *"preview-collaboration-staging.mjs enrollment"*) printf 'enrollment\\n' >> "$LOG"; [ "$ENROLLED" = true ] ;;
  *) printf '%064d' 7 ;;
esac
`);
      executable(bin, "curl", `out=""; data=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --data-binary) data="$2"; shift 2 ;;
    -H|-X|--max-time|--retry|--retry-delay|--retry-max-time) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *"/v1/sessions?"*) if [ "$SESSION" = true ]; then printf '[{"id":"sess_synthetic","last_active_at":1}]'; else printf '[]'; fi; exit 0 ;;
  *"/v1/sessions/"*"/tokens") printf '{"jwt":"synthetic.session.jwt"}'; exit 0 ;;
  *"/vm/${HANDLE}/api/terminal/run") ;;
  *) exit 22 ;;
esac
command="$(jq -r '.command | map(select(length < 150)) | join(" ")' <<< "$data")"
ok=true; stdout=""
case "$command" in
  *" identity ${HANDLE} "*) op=identity; ok="$IDENTITY"; stdout='{"machineId":"${MACHINE}"}' ;;
  *" claim "*) op=claim; ok="$CLAIM" ;;
  *"/usr/bin/sudo /usr/bin/python3 -I -c"*) op=apply; ok="$APPLY" ;;
  *"--on-active=300s"*"restore"*) op=arm; ok="$ARM" ;;
  *"restart matrix-gateway.service"*) op=restart; : > "$RESTARTED" ;;
  *" health") if [ -f "$RESTARTED" ] && [ "$RESTART_WORKS" = true ]; then op=health; pid=200; else op=baseline; pid=100; fi
    stdout="{\\"healthy\\":$HEALTHY,\\"collaboration\\":$HEALTHY,\\"pid\\":$pid}" ;;
  *"guard.py commit"*) op=commit ;;
  *"start --no-block"*) op=fire-guard ;;
  *"stop "*".timer"*) op=disarm ;;
  *) op="unknown:$command" ;;
esac
printf '%s\\n' "$op" >> "$LOG"
if [ "$ok" = true ]; then code=0; else code=1; fi
jq -cn --arg stdout "$stdout" --argjson code "$code" '{exitCode:$code,timedOut:false,truncated:false,signal:null,stdout:$stdout}' > "$out"
`);
      const result = spawnSync("bash", ["-euc", connectStep], { cwd: directory, encoding: "utf8", timeout: 20_000, env: {
        PATH: `${bin}:${process.env.PATH}`, LOG: log, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_STEP_SUMMARY: "/dev/null",
        PR_NUMBER: "1990", PREVIEW_VPS_CONTROL_URL: "https://control.example.test", GCP_PROJECT_ID: "project",
        PREVIEW_COLLABORATION_OWNER_USER_ID: OWNER, CLERK_SECRET_KEY: "sk_synthetic",
        PREVIEW_TAG_URL: "https://pr-1990---preview.example.test", COLLABORATION_CLIENT_ORIGINS: "https://preview.example.test",
        SESSION: String(scenario.session ?? true), IDENTITY: String(scenario.identity ?? true), REGISTER: String(scenario.register ?? true),
        CLAIM: String(scenario.claim ?? true), RESTARTED: join(directory, "restarted"), RESTART_WORKS: String(scenario.restarted ?? true),
        APPLY: String(scenario.apply ?? true), ARM: String(scenario.arm ?? true), HEALTHY: String(scenario.healthy ?? true),
        ENROLLED: String(scenario.enrolled ?? true),
      } });
      return { ...result, operations: readFileSync(log, "utf8").split("\n").filter((line) => line && !line.startsWith("gcloud")) };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  it("verifies identity, registers, arms the guard, claims, re-points, then commits after health and enrollment", () => {
    const result = runConnect({});
    expect(result.status, result.stderr).toBe(0);
    expect(result.operations).toEqual(["identity", "register", "arm", "claim", "apply", "baseline", "restart", "health", "enrollment", "commit", "disarm"]);
    // Values appear only inside the masking commands that register them.
    const printed = `${result.stdout}${result.stderr}`.split("\n").filter((line) => !line.startsWith("::add-mask::"));
    expect(printed.join("\n")).not.toContain("synthetic-secret-value");
    expect(printed.join("\n")).not.toContain("synthetic.session.jwt");
    expect(`${result.stdout}${result.stderr}`).toContain("::add-mask::synthetic-secret-value");
  });

  it("sends host scripts in capped chunks that the loader runs unchanged", () => {
    const start = connectStep.indexOf("\nloader=");
    const end = connectStep.indexOf("\nif ! address=");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const directory = mkdtempSync(join(tmpdir(), "preview-collaboration-loader-"));
    try {
      const script = join(directory, "echo.py");
      // Longer than one chunk, so the loader must join several arguments.
      writeFileSync(script, `${"# padding\n".repeat(900)}import json, sys\nprint(json.dumps({"argv": sys.argv[1:], "name": __name__, "source": len(LOADED_SOURCE)}))\n`);
      const built = spawnSync("bash", ["-euc", `${connectStep.slice(start, end)}\nscript_command root "$SCRIPT" 5000 first "second arg"`], {
        encoding: "utf8", env: { PATH: process.env.PATH, SCRIPT: script },
      });
      expect(built.status, built.stderr).toBe(0);
      const command = JSON.parse(built.stdout) as { command: string[]; timeoutMs: number };
      expect(command.timeoutMs).toBe(5000);
      expect(command.command.slice(0, 4)).toEqual(["/usr/bin/sudo", "/usr/bin/python3", "-I", "-c"]);
      expect(command.command.length).toBeLessThanOrEqual(64);
      for (const argument of command.command) expect(argument.length).toBeLessThanOrEqual(4096);
      const executed = spawnSync(command.command[1]!.replace("/usr/bin/", ""), command.command.slice(2), { encoding: "utf8" });
      expect(executed.status, executed.stderr).toBe(0);
      expect(JSON.parse(executed.stdout)).toEqual({ argv: ["first", "second arg"], name: "__main__", source: readFileSync(script, "utf8").length });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("names the guard timer the way the claim checks it", () => {
    expect(connectStep).toContain('guard_unit="matrix-preview-collaboration-guard-${nonce}"');
    expect(readFileSync("scripts/preview-collaboration-guard.py", "utf8"))
      .toContain('TIMER = "matrix-preview-collaboration-guard-{}.timer"');
  });

  it("never replays a transient systemd unit after a lost response", () => {
    const scheduling = connectStep.split("\n").filter((line) => line.includes("send_runtime_command \"$body\""));
    const once = scheduling.filter((line) => line.includes("send_runtime_command \"$body\" once"));
    expect(once.map((line) => line.trim())).toEqual([
      'if ! send_runtime_command "$body" once; then',
      'send_runtime_command "$body" once || fail_connection "The gateway restart could not be scheduled; restoring the host environment."',
    ]);
    const systemdRun = connectStep.match(/\/usr\/bin\/systemd-run/g) ?? [];
    expect(systemdRun).toHaveLength(once.length);
  });

  it("changes nothing when the host cannot prove it is this collaboration preview", () => {
    const result = runConnect({ identity: false });
    expect(result.status).not.toBe(0);
    expect(result.operations).toEqual(["identity"]);
  });

  it("asks for an owner sign-in when the collaboration owner has no active session", () => {
    const result = runConnect({ session: false });
    expect(result.status).not.toBe(0);
    expect(result.operations).toEqual([]);
    expect(result.stderr).toContain("Sign in");
  });

  it("stops before touching the host when staging registration fails", () => {
    const result = runConnect({ register: false });
    expect(result.status).not.toBe(0);
    expect(result.operations).toEqual(["identity", "register"]);
  });

  it("changes nothing on the host until the guard is armed and the claim recorded", () => {
    // A failed claim leaves ownership, and the earlier owner's timer, untouched.
    expect(runConnect({ arm: false }).operations).toEqual(["identity", "register", "arm"]);
    expect(runConnect({ claim: false }).operations).toEqual(["identity", "register", "arm", "claim"]);
  });

  it("fires the armed guard when the binding is refused", () => {
    const refused = runConnect({ apply: false });
    expect(refused.status).not.toBe(0);
    expect(refused.operations).toEqual(["identity", "register", "arm", "claim", "apply", "fire-guard"]);
  });

  it("fires the guard to restore and restart when health or enrollment fails", () => {
    const unhealthy = runConnect({ healthy: false });
    expect(unhealthy.status).not.toBe(0);
    expect(unhealthy.operations.slice(0, 7)).toEqual(["identity", "register", "arm", "claim", "apply", "baseline", "restart"]);
    expect(unhealthy.operations.filter((operation) => operation === "health")).toHaveLength(12);
    expect(unhealthy.operations.at(-1)).toBe("fire-guard");
    expect(unhealthy.operations).not.toContain("commit");
    const unenrolled = runConnect({ enrolled: false });
    expect(unenrolled.status).not.toBe(0);
    expect(unenrolled.operations).toEqual(["identity", "register", "arm", "claim", "apply", "baseline", "restart", "health", "enrollment", "fire-guard"]);
  });

  it("never accepts the pre-restart gateway process as the healthy, enrolled one", () => {
    const stale = runConnect({ restarted: false });
    expect(stale.status).not.toBe(0);
    expect(stale.operations.filter((operation) => operation === "baseline")).toHaveLength(13);
    expect(stale.operations).not.toContain("enrollment");
    expect(stale.operations.at(-1)).toBe("fire-guard");
  });
});
