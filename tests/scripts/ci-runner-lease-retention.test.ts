import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
it('recurring cleanup removes only aged completed owned evidence, keeps active/uncertain state and never follows links',()=>{
 const result=spawnSync('python3',['-I','-c',`import sys\nsys.dont_write_bytecode=True\nsys.path.insert(0,${JSON.stringify(resolve('scripts/ci/runner'))})\n
from lease_retention import cleanup_results
from lease_store import LeaseStore
import tempfile,time,os,json
from pathlib import Path
with tempfile.TemporaryDirectory() as td:
 root=Path(td);results=root/'results';results.mkdir(mode=0o700);store=LeaseStore(root/'leases')
 now=time.time()
 def row(index,status):
  lease=format(index,'032x');path=results/('lease.'+lease);path.mkdir(mode=0o700);(path/'evidence').mkdir(mode=0o700)
  store._write(lease,dict(status=status,leaseId=lease,created=now-900000,cancelled=False),create=True)
  os.utime(path,(now-900000,now-900000));return path
 completed=row(1,'completed');active=row(2,'queued')
 unknown=results/('lease.'+'3'*32);unknown.mkdir(mode=0o700)
 target=root/'keep';target.mkdir();(target/'data').write_text('owner data')
 link=results/('lease.'+'4'*32);link.symlink_to(target)
 cleanup_results(root,now=now)
 assert not completed.exists() and active.exists() and unknown.exists() and link.is_symlink() and (target/'data').read_text()=='owner data'
`],{encoding:'utf8',timeout:10_000});expect(result.status,result.stderr||result.stdout).toBe(0);
});
