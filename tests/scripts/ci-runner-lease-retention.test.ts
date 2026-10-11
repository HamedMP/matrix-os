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

function python(body: string) {
 const result=spawnSync('python3',['-I','-c',`import sys
sys.dont_write_bytecode=True
sys.path.insert(0,${JSON.stringify(resolve('scripts/ci/runner'))})
${body}`],{encoding:'utf8',timeout:10_000});
 expect(result.status,result.stderr||result.stdout).toBe(0);
}
describe('completed lease expiry ownership',()=>{
 it('retains records through the seven-day result-mtime skew and later releases all 32 result slots',()=>python(`
from lease_retention import cleanup_results
from lease_store import LeaseStore
import tempfile,time,os
from pathlib import Path
with tempfile.TemporaryDirectory() as td:
 root=Path(td);results=root/'results';results.mkdir(mode=0o700);store=LeaseStore(root/'leases');now=time.time()
 for index in range(32):
  lease=format(index,'032x');path=results/('lease.'+lease);path.mkdir(mode=0o700);(path/'evidence').mkdir(mode=0o700)
  store._write(lease,dict(status='completed',leaseId=lease,created=now-604801,cancelled=False),create=True)
  # A result completed later than its requesting lease was created.
  os.utime(path,(now-604741,now-604741))
  log=root/(lease+'.log');log.write_text('bounded evidence');log.chmod(0o600);os.utime(log,(now-604741,now-604741))
 cleanup_results(root,now=now)
 with store.locked():records=store.records()
 # The 20-result cap may evict older rows; every retained row still has an owner.
 retained=list(results.iterdir());assert len(retained)==20
 assert len(records)==20 and all(store.read(p.name[6:])['status']=='completed' for p in retained)
 cleanup_results(root,now=now+900000)
 assert list(results.iterdir())==[] and not list(root.glob('*.log'))
 with store.locked():assert store.records()==[]
`));
 it('retries an expired completed log-only remnant after evidence removal was interrupted',()=>python(`
from lease_retention import cleanup_results
from lease_store import LeaseStore
import tempfile,time,os
from pathlib import Path
with tempfile.TemporaryDirectory() as td:
 root=Path(td);(root/'results').mkdir(mode=0o700);store=LeaseStore(root/'leases');now=time.time();lease='a'*32
 store._write(lease,dict(status='completed',leaseId=lease,created=now-900000,cancelled=False),create=True)
 log=root/(lease+'.log');log.write_text('remaining owned log');log.chmod(0o600);os.utime(log,(now-900000,now-900000))
 with store.locked():assert len(store.records())==1
 cleanup_results(root,now=now)
 assert not log.exists()
 with store.locked():assert store.records()==[]
`));
 it('preserves ownership and target bytes when the remaining log is a symlink',()=>python(`
from lease_retention import cleanup_results
from lease_store import LeaseStore
import tempfile,time
from pathlib import Path
with tempfile.TemporaryDirectory() as td:
 root=Path(td);(root/'results').mkdir(mode=0o700);store=LeaseStore(root/'leases');lease='b'*32
 store._write(lease,dict(status='completed',leaseId=lease,created=time.time()-900000,cancelled=False),create=True)
 target=root/'owner-data';target.write_text('preserve');log=root/(lease+'.log');log.symlink_to(target)
 with store.locked():assert len(store.records())==1
 try:cleanup_results(root)
 except ValueError:pass
 else:raise AssertionError('untrusted log accepted')
 assert log.is_symlink() and target.read_text()=='preserve' and store.read(lease)['status']=='completed'
`));
});
