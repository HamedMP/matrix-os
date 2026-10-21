import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
function python(body:string){const result=spawnSync('python3',['-I','-c',`import sys\nsys.dont_write_bytecode=True\nsys.path.insert(0,${JSON.stringify(resolve('scripts/ci/runner'))})\n${body}`],{encoding:'utf8',timeout:10_000});expect(result.status,result.stderr||result.stdout).toBe(0);}
describe('bounded root-owned child commands',()=>{
 it('accepts bounded input/output with exact arguments and returns failure status',()=>python(`
from host_command import command
import sys
p=command([sys.executable,'-c','import sys;data=sys.stdin.buffer.read();sys.stdout.buffer.write(data);sys.stderr.write("error");sys.exit(42)'],data=b'public',timeout=2,cap=100)
assert p.stdout==b'public' and p.stderr==b'error' and p.returncode==42
`));
 it('transports a two-MiB trusted manifest and rejects larger input before spawning',()=>python(`
from host_command import command
import sys
raw=b'x'*(2*1024*1024)
p=command([sys.executable,'-c','import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'],data=raw,timeout=2,cap=len(raw)+100)
assert p.returncode==0 and p.stdout==raw
try:command([sys.executable,'-c','raise AssertionError("must not spawn")'],data=raw+b'x',timeout=2)
except ValueError:pass
else:raise AssertionError('manifest input cap missing')
`));
 it('kills and reaps an overflowing owned process without retaining unbounded bytes',()=>python(`
from host_command import command
import sys
try:command([sys.executable,'-c','import sys;sys.stdout.write("x"*100000);sys.stdout.flush()'],timeout=2,cap=1024)
except ValueError:pass
else:raise AssertionError('output bound missing')
`));
 it('keeps production Docker clients in the trusted wrapper owned process group',()=>python(`
from host_command import host_command
import os,sys
p=host_command([sys.executable,'-c','import os;print(os.getpgrp())'],timeout=2,cap=100)
assert p.returncode==0 and int(p.stdout)==os.getpgrp()
`));
 it('bounds timeout even for an owned child ignoring TERM',()=>python(`
from host_command import command
import sys,time
start=time.monotonic()
try:command([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],timeout=.1,cap=1024)
except TimeoutError:pass
else:raise AssertionError('deadline missing')
assert time.monotonic()-start<3
`));
});
