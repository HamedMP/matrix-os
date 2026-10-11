import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root=resolve('scripts/ci/runner');
describe('fixed privileged lease entrypoint',()=>{
 it.each([[[]],[['run','main']],[['shell','a'.repeat(32)]],[['run','a'.repeat(32),'extra']]])('rejects malformed CLI before any state or workload allocation (%j)',(args)=>{
  const result=spawnSync('python3',['-I',resolve(root,'lease.py'),...args],{encoding:'utf8',timeout:5000});
  expect(result.status,result.stderr).toBe(64);
 });
 it('never accepts caller paths, environment policy overrides or capability arguments',()=>{
  const source=readFileSync(resolve(root,'lease.py'),'utf8');
  expect(source).toContain("'/etc/matrix-ci/runner.json'");
  expect(source).toContain("'/var/lib/matrix-ci'");
  expect(source).toContain('os.geteuid() != 0');
  expect(source).not.toMatch(/getenv|environ\[/);
  expect(source).toContain('verify_harness');
  expect(source).toContain('validate_envelope');
 });
});
