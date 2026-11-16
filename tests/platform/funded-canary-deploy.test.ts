import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const harness = String.raw`
import importlib.util, json, os, sys
from datetime import datetime, timedelta, timezone
spec = importlib.util.spec_from_file_location('release_gate', 'scripts/verify-funded-relay-evidence.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
case = sys.argv[1]
source = 'a' * 40
tag = 'relay-' + source[:12]
origin = 'https://matrix-ai-relay-production-fixture-ey.a.run.app'
old = {'revisionName': 'matrix-ai-relay-production-old', 'percent': 100}
candidate = {'revisionName': 'matrix-ai-relay-production-new', 'tag': tag, 'url': 'https://' + tag + '---' + origin[8:]}
service = {'status': {'traffic': [old, candidate], 'url': origin, 'latestReadyRevisionName': candidate['revisionName']}}
container = {'image': 'fixture/image@sha256:' + 'b' * 64, 'env': [
    {'name': 'MATRIX_FUNDED_AI_ENABLED', 'value': 'true'},
    {'name': 'PLATFORM_INTERNAL_URL', 'value': 'https://app.matrix-os.com'},
]}
revision = {'metadata': {'labels': {'matrix-source-sha': source}}, 'spec': {'containers': [container]},
    'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}
calls = []
def cloud(kind, name):
    calls.append([kind, name])
    return service if kind == 'services' else revision
gate.cloud_json = cloud
window = timedelta(hours=-1 if case == 'expired' else 1)
expires = (datetime.now(timezone.utc) + window).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
os.environ.update(DEPLOY_ENVIRONMENT='production', GITHUB_REF='refs/heads/main', MATRIX_FUNDED_AI_RELAY_URL=origin,
    MATRIX_FUNDED_AI_CANARY_BINDING=json.dumps({'sourceSha': source, 'expiresAt': expires}))
if case == 'drifted-sha': revision['metadata']['labels']['matrix-source-sha'] = 'b' * 40
if case == 'wrong-origin': os.environ['MATRIX_FUNDED_AI_RELAY_URL'] = 'https://other.a.run.app'
if case == 'registry-enabled': container['env'].append({'name': gate.REGISTRY_ENV, 'value': 'true'})
if case == 'positive-traffic': old['percent'] = 99; candidate['percent'] = 1
if case == 'latest-traffic': old.update(latestRevision=True)
if case == 'unready': revision['status']['conditions'][0]['status'] = 'False'
if case == 'other-platform': container['env'][1]['value'] = 'https://staging.matrix-os.com'
if case == 'unpinned-image': container['image'] = 'fixture/image:latest'
if case == 'staging': os.environ['DEPLOY_ENVIRONMENT'] = 'staging'
if case == 'other-ref': os.environ['GITHUB_REF'] = 'refs/heads/feature'
try:
    gate.platform_canary_preflight()
except (ValueError, KeyError, TypeError):
    accepted = False
else:
    accepted = True
print(json.dumps({'accepted': accepted, 'calls': calls}))
`;

function verify(scenario: string) {
  const run = spawnSync("python3", ["-c", harness, scenario], {
    encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as { accepted: boolean; calls: string[][] };
}

describe("production canary deployment preflight", () => {
  it("checks the live, pinned zero-traffic tag on the configured Relay service", () => {
    expect(verify("valid")).toEqual({ accepted: true, calls: [
      ["services", "matrix-ai-relay-production"], ["revisions", "matrix-ai-relay-production-new"],
    ] });
  });
  it("lets an expired binding fall back without looking up an old candidate", () => {
    expect(verify("expired")).toEqual({ accepted: true, calls: [] });
  });
  it.each(["drifted-sha", "wrong-origin", "registry-enabled", "positive-traffic", "latest-traffic", "unready",
    "other-platform", "unpinned-image", "staging", "other-ref"])("rejects %s", scenario => {
    expect(verify(scenario).accepted).toBe(false);
  });
});
