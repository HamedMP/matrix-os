import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const workflow = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8"));
const script = workflow.jobs["connect-slack-pilot-preview"].steps.find((step: { name?: string }) =>
  step.name === "Connect the preview VM to the isolated Slack backend under a rollback guard").run as string;
const machineId = "3f6b1a2c-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function run(failure = "") {
  const directory = mkdtempSync(join(tmpdir(), "slack-connection-order-"));
  function executable(name: string, source: string) {
    const target = join(directory, name);
    writeFileSync(target, `#!/usr/bin/env bash\n${source}`);
    chmodSync(target, 0o700);
  }
  try {
    symlinkSync(resolve("scripts"), join(directory, "scripts"));
    writeFileSync(join(directory, "operations"), "");
    executable("sleep", ":\n");
    executable("date", "printf '2026-10-07T12:00:00Z\\n'\n");
    executable("gcloud", "printf 'synthetic-preview-secret'\n");
    executable("node", `case "$*" in
  *"slack-preview-runtime.mjs register"*)
    printf 'register\\n' >> "$ROOT/operations"
    [ -f "$ROOT/committed" ] || : > "$ROOT/published-before-commit"
    [ "$FAILURE" != register ] || exit 1
    : > "$ROOT/registered"
    [ "$FAILURE" != register-response ] ;;
  *"preview-collaboration-staging.mjs enrollment"*)
    printf 'enrollment\\n' >> "$ROOT/operations"
    [ -f "$ROOT/registered" ] && [ "$FAILURE" != enrollment ] ;;
  *) printf '%064d' 7 ;;
esac
`);
    executable("curl", `output=""; data=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --data-binary) data="$2"; shift 2 ;;
    -H|-X|--max-time|--retry|--retry-delay|--retry-max-time) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *"/v1/sessions?"*) printf '[{"id":"sess_synthetic"}]'; exit 0 ;;
  *"/v1/sessions/"*"/tokens") printf '{"jwt":"synthetic.session.jwt"}'; exit 0 ;;
esac
command="$(jq -r '.command | map(select(length < 150)) | join(" ")' <<< "$data")"
ok=true; stdout=""
case "$command" in
  *" identity pr-2079 "*) operation=identity; stdout='{"machineId":"${machineId}"}' ;;
  *" prepare "*) operation=prepare ;;
  *" claim "*) operation=claim ;;
  *"/usr/bin/sudo /usr/bin/python3 -I -c"*) operation=apply ;;
  *"--on-active=300s"*"restore"*) operation=arm ;;
  *"restart matrix-gateway.service"*) operation=restart; : > "$ROOT/restarted" ;;
  *" health")
    operation=health; pid=100; healthy=true
    [ ! -f "$ROOT/restarted" ] || pid=200
    [ "$FAILURE" != health ] || healthy=false
    stdout="{\\"healthy\\":$healthy,\\"collaboration\\":$healthy,\\"pid\\":$pid}" ;;
  *"guard.py commit"*) operation=commit; [ "$FAILURE" = commit ] || : > "$ROOT/committed" ;;
  *"start --no-block"*) operation=restore; [ -f "$ROOT/committed" ] || : > "$ROOT/restored" ;;
  *"stop "*".timer"*) operation=disarm ;;
  *) operation=unknown ;;
esac
[ "$FAILURE" != "$operation" ] || ok=false
printf '%s\\n' "$operation" >> "$ROOT/operations"
code=0; [ "$ok" = true ] || code=1
jq -cn --arg stdout "$stdout" --argjson code "$code" '{exitCode:$code,timedOut:false,truncated:false,signal:null,stdout:$stdout}' > "$output"
`);
    const result = spawnSync("bash", ["-euc", script], {
      cwd: directory, encoding: "utf8", timeout: 20_000,
      env: { PATH: `${directory}:${process.env.PATH}`, ROOT: directory, FAILURE: failure,
        PR_NUMBER: "2079", GCP_PROJECT_ID: "synthetic", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
        GITHUB_STEP_SUMMARY: join(directory, "summary"), PREVIEW_VPS_CONTROL_URL: "https://control.example.test",
        PREVIEW_RUNTIME_OWNER_ID: "user_synthetic", CLERK_SECRET_KEY: "sk_synthetic", SLACK_PILOT_APP_ID: "A123456",
        PREVIEW_TAG_URL: "https://preview.example.test", PREVIEW_CLIENT_ORIGINS: "https://preview.example.test",
        PREVIEW_MACHINE_ID: machineId, PREVIEW_ADDRESS: "192.0.2.10" },
    });
    return { status: result.status, stderr: result.stderr,
      registered: existsSync(join(directory, "registered")), committed: existsSync(join(directory, "committed")),
      restored: existsSync(join(directory, "restored")), publishedBeforeCommit: existsSync(join(directory, "published-before-commit")),
      operations: readFileSync(join(directory, "operations"), "utf8").trim().split("\n"),
      summary: existsSync(join(directory, "summary")) ? readFileSync(join(directory, "summary"), "utf8") : "" };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("Slack preview route publication and VM rollback", () => {
  it("publishes a route only after the healthy VM binding is committed, then verifies enrollment", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result).toMatchObject({ registered: true, committed: true, restored: false, publishedBeforeCommit: false });
    expect(result.operations.indexOf("enrollment")).toBeGreaterThan(result.operations.indexOf("register"));
    expect(result.summary).toContain("The Slack pilot is connected");
  });
  it.each(["prepare", "arm", "claim", "apply", "health", "restart", "commit"])("does not replace the prior database route when %s fails", (failure) => {
    const result = run(failure);
    expect(result.status).not.toBe(0);
    expect(result.registered).toBe(false);
    expect(result.operations).not.toContain("register");
    expect(result.summary).toBe("");
  });
  it.each(["register", "register-response", "enrollment"])("keeps the committed VM configuration consistent after %s fails", (failure) => {
    const result = run(failure);
    expect(result.status).not.toBe(0);
    expect(result).toMatchObject({ committed: true, restored: false, publishedBeforeCommit: false });
    expect(result.operations).not.toContain("restore");
    expect(result.summary).toBe("");
    expect(result.registered).toBe(failure !== "register");
  });
});
