import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root = resolve("scripts/ci/runner");
function python(body: string) {
  const result = spawnSync("python3", ["-I", "-c", `import sys\nsys.dont_write_bytecode=True\nsys.path.insert(0,${JSON.stringify(root)})\n${body}`], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}
describe("bounded controller control channel", () => {
  it("rejects duplicate keys, nonfinite JSON and oversized records", () => python(`
import os
from lease_io import decode,ControlPipe
for raw in (b'{"type":1,"type":2}',b'{"n":NaN}',b'\\xff'):
 try:decode(raw)
 except (ValueError,UnicodeError):pass
 else:raise AssertionError('ambiguous JSON accepted')
r,w=os.pipe();output,unused=os.pipe()
try:
 pipe=ControlPipe(r,unused)
 pipe.buffer.extend(b'x'*16385)
 try:pipe.poll(0)
 except ValueError:pass
 else:raise AssertionError('record cap missing')
finally:
 for fd in (r,w,output,unused):os.close(fd)
`));
  it("preserves records split across reads and fails partial EOF", () => python(`
import os
from lease_io import ControlPipe
r,w=os.pipe();a,b=os.pipe()
try:
 pipe=ControlPipe(r,b)
 os.write(w,b'{"v":');assert pipe.poll(0)==[]
 os.write(w,b'1}\\n');assert pipe.poll(0)==[{'v':1}]
 os.write(w,b'{');pipe.poll(0);os.close(w);w=None
 try:pipe.poll(0)
 except ValueError:pass
 else:raise AssertionError('partial EOF accepted')
finally:
 for fd in (r,w,a,b):
  if fd is not None:os.close(fd)
`));
  it("bounds stdout records and lifetime bytes without exposing secrets", () => python(`
import os
from lease_io import ControlPipe
r,w=os.pipe();a,b=os.pipe()
try:
 pipe=ControlPipe(r,b)
 try:pipe.emit({'data':'x'*32768})
 except ValueError:pass
 else:raise AssertionError('stdout record unbounded')
 pipe=ControlPipe(r,b);pipe.sent=1024*1024
 try:pipe.emit({'type':'queued'})
 except ValueError:pass
 else:raise AssertionError('stdout total unbounded')
finally:
 for fd in (r,w,a,b):os.close(fd)
`));
});
