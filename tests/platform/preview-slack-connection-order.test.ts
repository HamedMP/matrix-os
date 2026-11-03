import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
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
    printf '%s' "\${PREVIEW_HANDLE:-}" > "$ROOT/registration-handle"
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
  *"/vm/pr-2079/api/system/info")
    printf 'preview-api\\n' >> "$ROOT/operations"
    [ -f "$ROOT/committed" ] && [ -f "$ROOT/registered" ] || exit 22
    [ "$FAILURE" != preview-api ] || exit 22
    printf '{"capabilities":{"collaboration":true}}' > "$output"; exit 0 ;;
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
  *" probe") operation=preview-auth; stdout='{"previewAuthenticated":true}' ;;
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
        PR_NUMBER: "2079", PREVIEW_DATABASE_SECRET_VERSION: "1", PREVIEW_PLATFORM_SECRET_VERSION: "29", GCP_PROJECT_ID: "synthetic", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
        GITHUB_STEP_SUMMARY: join(directory, "summary"), PREVIEW_VPS_CONTROL_URL: "https://control.example.test",
        PREVIEW_RUNTIME_OWNER_ID: "user_synthetic", CLERK_SECRET_KEY: "sk_synthetic", SLACK_PILOT_APP_ID: "A123456",
        PREVIEW_TAG_URL: "https://preview.example.test", PREVIEW_CLIENT_ORIGINS: "https://preview.example.test",
        PREVIEW_MACHINE_ID: machineId, PREVIEW_ADDRESS: "192.0.2.10" },
    });
    return { status: result.status, stderr: result.stderr,
      registrationHandle: existsSync(join(directory, "registration-handle")) ? readFileSync(join(directory, "registration-handle"), "utf8") : null,
      registered: existsSync(join(directory, "registered")), committed: existsSync(join(directory, "committed")),
      restored: existsSync(join(directory, "restored")), publishedBeforeCommit: existsSync(join(directory, "published-before-commit")),
      operations: readFileSync(join(directory, "operations"), "utf8").trim().split("\n"),
      summary: existsSync(join(directory, "summary")) ? readFileSync(join(directory, "summary"), "utf8") : "" };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("Slack preview route publication and VM rollback", () => {
  it("passes the exact committed preview handle to the registration process", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.registrationHandle).toBe("pr-2079");
  });
  it("publishes a route only after the healthy VM binding is committed, then verifies enrollment", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result).toMatchObject({ registered: true, committed: true, restored: false, publishedBeforeCommit: false });
    expect(result.operations).toContain("preview-api");
    expect(result.operations.indexOf("preview-auth")).toBeLessThan(result.operations.indexOf("commit"));
    expect(result.operations.indexOf("preview-api")).toBeGreaterThan(result.operations.indexOf("register"));
    expect(result.operations.indexOf("enrollment")).toBeGreaterThan(result.operations.indexOf("register"));
    expect(result.summary).toContain("The Slack pilot is connected");
  });
  it.each(["prepare", "arm", "claim", "apply", "health", "restart", "preview-auth", "commit"])("does not replace the prior database route when %s fails", (failure) => {
    const result = run(failure);
    expect(result.status).not.toBe(0);
    expect(result.registered).toBe(false);
    expect(result.operations).not.toContain("register");
    expect(result.summary).toBe("");
  });
  it.each(["register", "register-response", "preview-api", "enrollment"])("keeps the committed VM configuration consistent after %s fails", (failure) => {
    const result = run(failure);
    expect(result.status).not.toBe(0);
    expect(result).toMatchObject({ committed: true, restored: false, publishedBeforeCommit: false });
    expect(result.operations).not.toContain("restore");
    expect(result.summary).toBe("");
    expect(result.registered).toBe(failure !== "register");
    if(failure==="preview-api")expect(run().status).toBe(0);
  });
});


afterEach(() => vi.unstubAllEnvs());
describe("isolated preview ordinary API authentication", () => {
  const owner = "user_synthetic";
  const previewToken = buildPlatformVerificationToken("pr-2079", "preview-only-secret");
  const productionToken = buildPlatformVerificationToken("pr-2079", "production-secret");
  function gateway() {
    vi.stubEnv("MATRIX_PREVIEW_RUNTIME", "true");
    vi.stubEnv("MATRIX_HANDLE", "pr-2079");
    vi.stubEnv("MATRIX_RUNTIME_SLOT", "pr-2079");
    vi.stubEnv("MATRIX_USER_ID", owner);
    vi.stubEnv("MATRIX_CLERK_USER_ID", owner);
    vi.stubEnv("MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN", previewToken);
    const app = new Hono(); app.use("*", authMiddleware(productionToken));
    app.get("/api/system/info", c => c.json({owner:requireRequestPrincipal(c,{configuredUserId:owner,isTrustedSingleUserGateway:true}).userId,capabilities:{collaboration:true}}));
    app.post("/api/terminal/run", c => c.json({control:true}));
    app.post("/api/internal/private", c => c.json({internal:true}));
    return app;
  }
  function headers(token=previewToken, actor=owner, proofKey=token) {
    return {authorization:`Bearer ${token}`,"x-platform-user-id":actor,"x-platform-verified":createHmac("sha256",proofKey).update(actor).digest("hex")};
  }
  it("authenticates the tagged platform's actual forwarded owner bearer without replacing production control", async () => {
    const home=gateway();
    const platform=new Hono();
    platform.get("/vm/pr-2079/api/system/info", () => home.request("/api/system/info",{headers:headers()}));
    const response=await platform.request("/vm/pr-2079/api/system/info");
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({owner});
    expect((await home.request("/api/terminal/run",{method:"POST",headers:headers(productionToken)})).status).toBe(200);
    expect((await home.request("/api/internal/private",{method:"POST",headers:headers()})).status).toBe(401);
    expect((await home.request("/api/%69nternal/private",{method:"POST",headers:headers()})).status).toBe(401);
  });
  it("runs the real home probe against gateway authentication before a configuration commit",async()=>{
    const home=gateway();const directory=mkdtempSync(join(tmpdir(),"preview-auth-probe-"));
    writeFileSync(join(directory,"host.env"),`MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN=${previewToken}\nMATRIX_CLERK_USER_ID=${owner}\n`,{mode:0o640});
    const server=createServer((request,response)=>{
      void home.request("/api/system/info",{headers:request.headers as Record<string,string>}).then(async reply=>{response.writeHead(reply.status,{"content-type":"application/json"});response.end(await reply.text());}).catch(error=>{console.error("fixture gateway failed",error);response.writeHead(500);response.end();});
    });
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    try{
      const address=server.address();if(!address||typeof address==="string")throw Error("Missing fixture listener");
      const result=await new Promise<{code:number|null;out:string;err:string}>((done,reject)=>{
        const child=spawn("python3",["-I","-c",'import json,runpy,sys,pathlib; m=runpy.run_path(sys.argv[1],run_name="fixture"); print(json.dumps(m["probe"](pathlib.Path(sys.argv[2]),gateway=sys.argv[3])))',resolve("scripts/preview-collaboration-home.py"),directory,`http://127.0.0.1:${address.port}`],{timeout:10000});
        let out="",err="";child.stdout.on("data",chunk=>{out+=chunk;});child.stderr.on("data",chunk=>{err+=chunk;});child.once("error",reject);child.once("exit",code=>done({code,out,err}));
      });
      expect(result.code,result.err).toBe(0);expect(JSON.parse(result.out)).toEqual({previewAuthenticated:true});
    }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));rmSync(directory,{recursive:true,force:true});}
  });
  it.each(["missing-proof","foreign-owner","wrong-proof","wrong-slot","not-preview"])("rejects the preview bearer for %s",async failure=>{
    const home=gateway();let h:Record<string,string>=headers();
    if(failure==="missing-proof")delete h["x-platform-verified"];
    if(failure==="foreign-owner")h=headers(previewToken,"user_foreign");
    if(failure==="wrong-proof")h=headers(previewToken,owner,productionToken);
    if(failure==="wrong-slot")vi.stubEnv("MATRIX_RUNTIME_SLOT","primary");
    if(failure==="not-preview")vi.stubEnv("MATRIX_PREVIEW_RUNTIME","false");
    expect((await home.request("/api/system/info",{headers:h})).status).toBe(401);
  });
});


it("binds the extra preview credential while preserving production control and the rollback source",()=>{
 const directory=mkdtempSync(join(tmpdir(),"preview-auth-binding-"));
 try{
  const original=`MATRIX_HANDLE=pr-2079\nMATRIX_RUNTIME_SLOT=pr-2079\nMATRIX_MACHINE_ID=${machineId}\nMATRIX_CLERK_USER_ID=user_synthetic\nMATRIX_AUTH_TOKEN=${"a".repeat(64)}\nPLATFORM_INTERNAL_URL=https://production.example.test\n`;
  writeFileSync(join(directory,"host.env"),original,{mode:0o640});
  const binding={PLATFORM_INTERNAL_URL:"https://preview.example.test",UPGRADE_TOKEN:"b".repeat(64),MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN:"b".repeat(64),MATRIX_COLLABORATION_CLIENT_ORIGINS:"https://preview.example.test"};
  const result=spawnSync("python3",["-I","-c",'import json,runpy,sys,pathlib; m=runpy.run_path(sys.argv[1],run_name="fixture"); m["bind"](pathlib.Path(sys.argv[2]),"pr-2079","user_synthetic",sys.argv[3],json.loads(sys.argv[4]),False)',resolve("scripts/preview-collaboration-home.py"),directory,machineId,JSON.stringify(binding)],{encoding:"utf8",timeout:10000});
  expect(result.status,result.stderr).toBe(0);
  const actual=readFileSync(join(directory,"host.env"),"utf8");
  expect(actual).toContain(`MATRIX_AUTH_TOKEN=${"a".repeat(64)}\n`);
  expect(actual).toContain("MATRIX_PREVIEW_RUNTIME=true\n");
  expect(actual).toContain(`MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN=${"b".repeat(64)}\n`);
  expect(readFileSync(join(directory,".host.env.preview-collaboration-rollback"),"utf8")).toBe(original);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
