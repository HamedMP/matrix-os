import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sha = "a".repeat(40);
const tag = `relay-${sha.slice(0, 12)}`;
const serviceUrl = "https://matrix-ai-relay-abcdef-ey.a.run.app";

function routing(scenario: string, environment = "production", promote = false) {
  const program = String.raw`
import importlib.util, json, os, pathlib, sys, tempfile
spec=importlib.util.spec_from_file_location('gate','scripts/verify-funded-relay-evidence.py')
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
case=json.load(sys.stdin); scenario=case['scenario']; source='a'*40
tag='relay-'+source[:12]; base='https://matrix-ai-relay-abcdef-ey.a.run.app'
old={'tag':'candidate','revisionName':'matrix-ai-relay-old','percent':100,'url':'https://candidate---'+base[8:]}
other={'tag':'retained','revisionName':'matrix-ai-relay-other','url':'https://retained---'+base[8:]}
service={'status':{'url':base,'latestReadyRevisionName':'matrix-ai-relay-old','traffic':[old,other]}}
revision={'metadata':{'labels':{'matrix-source-sha':source}},'spec':{'containers':[{'image':'fixture@sha256:abc'}]},'status':{'conditions':[{'type':'Ready','status':'True'}]}}
gate.cloud_json=lambda kind,name: service if kind=='services' else revision
with tempfile.TemporaryDirectory(prefix='relay-routing-') as directory:
 output=pathlib.Path(directory,'env')
 os.environ.update({'DEPLOY_ENVIRONMENT':case['environment'],'PROMOTE':str(case['promote']).lower(),'GITHUB_REF':'refs/heads/main','GITHUB_SHA':source,
  'GITHUB_ENV':str(output),'AI_RELAY_CLOUD_RUN_SERVICE':'matrix-ai-relay','CANDIDATE_REVISION':'matrix-ai-relay-new','IMAGE_DIGEST':'fixture@sha256:abc'})
 if scenario=='invalid-source': os.environ['GITHUB_SHA']='a'*12
 if scenario=='occupied': service['status']['traffic'].append({'tag':tag,'revisionName':'matrix-ai-relay-already'})
 result={'accepted':False}
 try:
  gate.deployment_preflight()
  emitted=dict(line.split('=',1) for line in output.read_text().splitlines()) if output.exists() else {}
  os.environ.update(emitted)
  result['baselinePinned']=len(emitted.get('CANDIDATE_BASELINE_TRAFFIC_SHA256',''))==64
  if scenario in ('occupied','invalid-source','preflight'):
   result['accepted']=True
  else:
   if scenario=='during-build-default': old['revisionName']='matrix-ai-relay-changed'
   if scenario=='during-build-tag': other['revisionName']='matrix-ai-relay-changed'
   if scenario.startswith('during-build-'):
    gate.deployment_preflight()
    result['accepted']=True
   else:
    if scenario=='latest-pinned': old['latestRevision']=True
    # Resolve the pre-build LATEST route to the same effective old revision.
    if scenario=='latest-pinned':
     old.pop('revisionName')
     gate.deployment_preflight()
     old.pop('latestRevision');old['revisionName']='matrix-ai-relay-old'
    owned={'tag':tag,'revisionName':'matrix-ai-relay-new','url':'https://'+tag+'---'+base[8:]}
    service['status']['traffic'].append(owned)
    service['status']['latestReadyRevisionName']='matrix-ai-relay-new'
    if scenario=='default-drift': old['revisionName']='matrix-ai-relay-changed'
    if scenario=='tag-drift': other['url']='https://changed.a.run.app'
    if scenario=='tag-removed': service['status']['traffic'].remove(other)
    if scenario=='positive-owned': owned['percent']=1;old['percent']=99
    if scenario=='latest-owned': service['status']['traffic'].append({'latestRevision':True,'percent':100})
    if scenario=='duplicate-owned': service['status']['traffic'].append(dict(owned))
    if scenario=='wrong-url': owned['url']='https://candidate---'+base[8:]
    if scenario=='url-query': owned['url']+='?redirect=elsewhere'
    if scenario=='url-service': owned['url']='https://'+tag+'---other-abcdef-ey.a.run.app'
    if scenario=='prefix-collision': revision['metadata']['labels']['matrix-source-sha']=source[:12]+'c'*28
    if scenario=='not-ready': revision['status']['conditions'][0]['status']='False'
    if scenario=='no-baseline': os.environ.pop('CANDIDATE_BASELINE_TRAFFIC_SHA256',None)
    gate.candidate_isolation();result['accepted']=True
 except (ValueError,KeyError,TypeError) as error: result['reason']=str(error)
 print(json.dumps(result))
`;
  const result = spawnSync("python3", ["-c", program], {
    cwd: process.cwd(), input: JSON.stringify({ scenario, environment, promote }), encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { accepted: boolean; baselinePinned?: boolean; reason?: string };
}

describe("source-owned Relay candidate routing", () => {
  it.each(["production", "staging"])("pins existing routes and isolates only the new %s tag", environment => {
    expect(routing("valid", environment)).toMatchObject({ accepted: true, baselinePinned: true });
  });
  it("accepts LATEST pinning only when the effective old route is unchanged", () => {
    expect(routing("latest-pinned")).toMatchObject({ accepted: true, baselinePinned: true });
  });
  it.each(["production", "staging"])("rejects an occupied owned tag before building in %s", environment => {
    expect(routing("occupied", environment).accepted).toBe(false);
  });
  it("rejects a second staging promotion dispatch before rebuilding the same tag", () => {
    expect(routing("occupied", "staging", true).accepted).toBe(false);
    expect(routing("preflight", "staging", true)).toMatchObject({ accepted: true, baselinePinned: true });
  });
  it("requires the full source SHA before deriving a tag", () => {
    expect(routing("invalid-source").accepted).toBe(false);
  });
  it.each(["during-build-default", "during-build-tag", "default-drift", "tag-drift", "tag-removed",
    "positive-owned", "latest-owned", "duplicate-owned", "wrong-url", "url-query", "url-service",
    "prefix-collision", "not-ready", "no-baseline"])("fails closed on %s", scenario => {
    expect(routing(scenario).accepted).toBe(false);
  });

  it("runs the full deployment shell against the owned tag without moving existing aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-owned-deploy-"));
    try {
      const output = join(directory, "github-env");
      const workflow = readFileSync(join(process.cwd(), ".github/workflows/ai-relay-cloud-run.yml"), "utf8");
      const block = workflow.split("- name: Deploy candidate revision")[1]!.split("\n      - name:")[0]!.split("run: |\n")[1]!;
      const script = block.split("\n").map(line => line.replace(/^          /, "")).join("\n");
      const service = { status: { traffic: [
        { tag: "candidate", revisionName: "matrix-ai-relay-old", percent: 100, url: `https://candidate---${serviceUrl.slice(8)}` },
        { tag, revisionName: "matrix-ai-relay-new", url: `https://${tag}---${serviceUrl.slice(8)}` },
      ] } };
      const result = spawnSync("bash", ["-c", `
gcloud() {
  case "$1 $2 $3" in
    'run deploy matrix-ai-relay') printf '%s\\n' "$@"; return 0 ;;
    'run services describe') printf '%s' "$FIXTURE_SERVICE"; return 0 ;;
    'run revisions describe') printf '%s' "$IMAGE_DIGEST"; return 0 ;;
  esac
  return 1
}
sleep() { return 1; }
${script}
`], { encoding: "utf8", timeout: 10_000, env: {
        PATH: process.env.PATH, GITHUB_SHA: sha, GITHUB_ENV: output, CANDIDATE_TAG: tag,
        IMAGE_DIGEST: `fixture@sha256:${"b".repeat(64)}`, AI_RELAY_CLOUD_RUN_SERVICE: "matrix-ai-relay",
        AI_RELAY_CLOUD_RUN_SERVICE_ACCOUNT: "fixture", GCP_PROJECT_ID: "fixture", GCP_REGION: "fixture",
        PLATFORM_INTERNAL_URL: "https://platform.fixture.invalid", CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.fixture.invalid",
        GATEWAY_TOKEN_SECRET: "synthetic", GATEWAY_TOKEN_VERSION: "1", WORKERS_TOKEN_SECRET: "synthetic", WORKERS_TOKEN_VERSION: "1",
        CONTROL_TOKEN_SECRET: "synthetic", CONTROL_TOKEN_VERSION: "1", METADATA_SECRET_SECRET: "synthetic", METADATA_SECRET_VERSION: "1",
        MATRIX_FUNDED_SONNET_PRICING_REVIEW_VERSION: "synthetic", MATRIX_FUNDED_SONNET_PRICING_REVIEWED_AT: "synthetic", MATRIX_FUNDED_SONNET_PRICING_VALID_THROUGH: "synthetic",
        MATRIX_FUNDED_GLM_PRICING_REVIEW_VERSION: "synthetic", MATRIX_FUNDED_GLM_PRICING_REVIEWED_AT: "synthetic", MATRIX_FUNDED_GLM_PRICING_VALID_THROUGH: "synthetic",
        MATRIX_JEV_PRICING_REVIEW_VERSION: "synthetic", MATRIX_JEV_PRICING_REVIEWED_AT: "synthetic", MATRIX_JEV_PRICING_VALID_THROUGH: "synthetic",
        FIXTURE_SERVICE: JSON.stringify(service),
      } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const args = result.stdout.trim().split("\n");
      expect(args[args.indexOf("--tag") + 1]).toBe(tag);
      expect(args).toContain("--no-traffic");
      expect(args).not.toContain("candidate");
      expect(args.some(arg => /--(?:set|remove|clear)-tags/.test(arg))).toBe(false);
      expect(readFileSync(output, "utf8")).toBe(`CANDIDATE_URL=https://${tag}---${serviceUrl.slice(8)}\nCANDIDATE_REVISION=matrix-ai-relay-new\n`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
