import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const program = String.raw`
import importlib.util, json, os, sys
spec=importlib.util.spec_from_file_location('source','scripts/funded_relay_release_source.py')
source=importlib.util.module_from_spec(spec);spec.loader.exec_module(source)
case=json.load(sys.stdin); scenario=case['scenario']; release='a'*40; controller='b'*40; repo='HamedMP/matrix-os'
env={'GITHUB_REF':'refs/heads/main','GITHUB_SHA':controller,'GITHUB_REPOSITORY':repo,'REQUESTED_RELEASE_SOURCE_SHA':release}
ci={'id':77,'workflow_id':98,'head_sha':release,'head_branch':'main','event':'push','status':'completed','conclusion':'success','path':'.github/workflows/ci.yml','display_title':'CI coverage-v1 · '+release,'run_attempt':1,'repository':{'full_name':repo},'head_repository':{'full_name':repo}}
compare={'status':'ahead','base_commit':{'sha':release},'merge_base_commit':{'sha':release}}
if scenario=='equal': env['GITHUB_SHA']=release;controller=release;compare['status']='identical'
if scenario=='blank': env['REQUESTED_RELEASE_SOURCE_SHA']='';env['GITHUB_SHA']=release;controller=release;compare['status']='identical'
if scenario=='short': env['REQUESTED_RELEASE_SOURCE_SHA']='a'*12
if scenario=='branch': env['GITHUB_REF']='refs/heads/feature'
if scenario=='diverged': compare['status']='diverged';compare['merge_base_commit']['sha']='c'*40
if scenario=='wrong-base': compare['base_commit']['sha']='c'*40
if scenario=='wrong-controller': controller='c'*40
changes={'ci-sha':{'head_sha':'c'*40},'ci-branch':{'head_branch':'feature'},'ci-event':{'event':'workflow_dispatch'},'ci-failed':{'conclusion':'failure'},'ci-pending':{'status':'in_progress'},'ci-workflow':{'workflow_id':99},'ci-path':{'path':'.github/workflows/other.yml'},'ci-fork':{'head_repository':{'full_name':'other/repo'}},'ci-metadata':{'display_title':'CI metadata-v1 · '+release}}
ci.update(changes.get(scenario,{})); requested=[]
def api(path):
 requested.append(path)
 if scenario=='api-error': raise TimeoutError('fixture')
 if path.startswith('/commits/'): return {'sha':controller}
 if path.startswith('/compare/'): return compare
 if path=='/actions/workflows/ci.yml': return {'id':98,'path':'.github/workflows/ci.yml','state':'active'}
 if path=='/actions/runs/77/attempts/1/jobs?per_page=100':
  jobs=[{'name':'CI Results','conclusion':'success','status':'completed'}, {'name':'Type Check','conclusion':'success','status':'completed','steps':[{'name':'Type check all packages','conclusion':'success'}]}]+[{'name':f'Unit Tests ({n}/4)','conclusion':'success','status':'completed','steps':[{'name':f'Run GITHUB_SHA=... bun run test -- --shard={n}/4 --reporter=default','conclusion':'skipped' if scenario=='unit-skipped' else 'success'}]} for n in range(1,5)]
  if scenario=='missing-job': jobs.pop()
  return {'total_count':101 if scenario=='job-pagination' else len(jobs),'jobs':jobs}
 if path.startswith('/actions/workflows/98/runs?'):
  runs=[] if scenario=='ci-missing' else [ci]
  if scenario=='latest-failed': runs.append(dict(ci,id=78,conclusion='failure'))
  return {'total_count':11 if scenario=='pagination' else len(runs),'workflow_runs':runs}
 raise AssertionError(path)
try:
 binding=source.validate_source(api,env)
 print(json.dumps({'accepted':True,'binding':binding,'requested':requested}))
except (ValueError,TimeoutError,KeyError,TypeError) as error: print(json.dumps({'accepted':False,'message':str(error),'requested':requested}))
`;
function run(scenario: string) {
  const result = spawnSync("python3", ["-c", program], { input: JSON.stringify({ scenario }), encoding: "utf8", timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { accepted: boolean; binding?: { releaseSourceSha: string; controllerSha: string; sourceCiRunId: number } };
}

describe("fixed immutable Relay release source", () => {
  it.each(["valid", "equal", "blank"])("validates %s source without equating controller and release", scenario => {
    expect(run(scenario)).toMatchObject({ accepted: true, binding: { releaseSourceSha: "a".repeat(40), sourceCiRunId: 77 } });
  });
  it.each(["short", "branch", "diverged", "wrong-base", "wrong-controller", "ci-sha", "ci-branch", "ci-event", "ci-failed", "ci-pending", "ci-workflow", "ci-path", "ci-fork", "ci-missing", "latest-failed", "pagination", "api-error", "ci-metadata", "unit-skipped", "missing-job", "job-pagination"])("fails closed for %s", scenario => {
    expect(run(scenario).accepted).toBe(false);
  });
  it("checks source before checkout/build/cloud auth and keeps trusted controller separate", () => {
    const workflow = readFileSync(".github/workflows/ai-relay-cloud-run.yml", "utf8");
    expect(workflow.indexOf("verify-funded-relay-evidence.py release-source")).toBeLessThan(workflow.indexOf("- name: Checkout validated release source"));
    expect(workflow.indexOf("- name: Checkout validated release source")).toBeLessThan(workflow.indexOf("- name: Authenticate to Google Cloud"));
    expect(workflow).toContain("ref: ${{ env.RELEASE_SOURCE_SHA }}");
    expect(workflow).toContain("path: release-source");
    expect(workflow).toContain("gcloud builds submit release-source");
    expect(workflow).toContain('--config release-source/cloudbuild.ai-relay.yaml');
    expect(workflow).toContain('matrix-source-sha=${RELEASE_SOURCE_SHA}');
    expect(workflow).not.toContain('GITHUB_SHA=');
  });
});
