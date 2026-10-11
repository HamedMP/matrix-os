import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
function python(body: string) {
 const result=spawnSync("python3",["-I","-c",`import sys\nsys.dont_write_bytecode=True\nsys.path.insert(0,${JSON.stringify(resolve('scripts/ci/runner'))})\n${body}`],{encoding:'utf8',timeout:10_000});
 expect(result.status,result.stderr||result.stdout).toBe(0);
}
describe('installed admission policy',()=>{
 it('requires owned regular bounded config and rejects symlink, group write and unknown policy keys',()=>python(`
from lease_config import read_owned_json,validate_config
import os,tempfile,json
from pathlib import Path
config=dict(repository='HamedMP/matrix-os',controllerShas=['a'*40],imageDigest='sha256:'+'b'*64,harnessDigest='c'*64,modes=['shadow'])
assert validate_config(config)==config
with tempfile.TemporaryDirectory() as td:
 p=Path(td)/'config';p.write_text(json.dumps(config));p.chmod(0o600)
 assert read_owned_json(p,os.getuid())==config
 link=Path(td)/'link';link.symlink_to(p)
 for target in (link,):
  try:read_owned_json(target,os.getuid())
  except (OSError,ValueError):pass
  else:raise AssertionError('symlink accepted')
 p.chmod(0o660)
 try:read_owned_json(p,os.getuid())
 except ValueError:pass
 else:raise AssertionError('foreign writable policy accepted')
for bad in (dict(config,extra=True),dict(config,controllerShas=[]),dict(config,modes=['arbitrary']),dict(config,imageDigest='tag')):
 try:validate_config(bad)
 except ValueError:pass
 else:raise AssertionError('invalid policy accepted')
`));
 it('rejects installed input tampering and traversal in the digest manifest',()=>python(`
from lease_config import verify_harness
import tempfile,hashlib,os
from pathlib import Path
with tempfile.TemporaryDirectory() as td:
 root=Path(td);p=root/'lease.py';p.write_text('trusted');p.chmod(0o644)
 manifest=root/'harness.sha256';manifest.write_text(hashlib.sha256(p.read_bytes()).hexdigest()+'  lease.py\\n');manifest.chmod(0o644)
 digest=hashlib.sha256(manifest.read_bytes()).hexdigest()
 verify_harness(root,digest,os.getuid())
 p.write_text('changed')
 try:verify_harness(root,digest,os.getuid())
 except ValueError:pass
 else:raise AssertionError('modified installed input accepted')
 manifest.write_text('0'*64+'  ../outside\\n')
 try:verify_harness(root,hashlib.sha256(manifest.read_bytes()).hexdigest(),os.getuid())
 except ValueError:pass
 else:raise AssertionError('manifest escaped installed root')
`));
});
