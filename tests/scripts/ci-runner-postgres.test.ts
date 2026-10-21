import {spawnSync} from "node:child_process";
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {describe,expect,it} from "vitest";

function invoke(failure: "none" | "createdb" | "root" = "none") {
  const dir=mkdtempSync(resolve(tmpdir(),"matrix-ci-postgres-"));
  const bin=resolve(dir,"bin"), work=resolve(dir,"work");
  mkdirSync(bin); mkdirSync(work); mkdirSync(resolve(work,"results"));
  const executable=(name:string,source:string)=>{
    writeFileSync(resolve(bin,name),`#!/bin/bash\nset -euo pipefail\n${source}\n`); chmodSync(resolve(bin,name),0o755);
  };
  executable("id",`echo ${failure === "root" ? 0 : 10001}`);
  executable("timeout",'shift; exec "$@"');
  executable("initdb",'printf "initdb %s\\n" "$*" >> "$CALLS"');
  executable("pg_ctl",`printf 'pg_ctl %s\\n' "$*" >> "$CALLS"
if [[ "$*" == *" start" ]]; then touch "$WORK/postgres/postmaster.pid"; fi
if [[ "$*" == *" stop" ]]; then rm "$WORK/postgres/postmaster.pid"; fi`);
  executable("createdb",`printf 'createdb %s\\n' "$*" >> "$CALLS"; ${failure === "createdb" ? "exit 42" : "true"}`);
  const script=resolve(dir,"fixture.sh");
  writeFileSync(script,readFileSync("scripts/ci/runner/fixture-postgres.sh","utf8")
    .replaceAll("/work",work).replaceAll("/usr/lib/postgresql/16/bin",bin));
  try {
    const env={...process.env,PATH:`${bin}:${process.env.PATH}`,CALLS:resolve(dir,"calls"),WORK:work};
    delete env.MATRIX_TEST_POSTGRES_URL;
    delete env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL;
    const result=spawnSync("bash",["-c",`set -euo pipefail; source "$1"; trap stop_fixture_postgres EXIT; start_fixture_postgres; printf '%s\\n' "$MATRIX_PLATFORM_FIXTURE_POSTGRES_URL"; test -z "\${MATRIX_TEST_POSTGRES_URL:-}"`,"--",script],{encoding:"utf8",env,timeout:10000});
    let calls="";
    try {calls=readFileSync(resolve(dir,"calls"),"utf8");}
    catch(error) {if(!(error instanceof Error && "code" in error && error.code === "ENOENT"))throw error;}
    return {result,calls};
  } finally {rmSync(dir,{recursive:true,force:true});}
}

describe("isolated native PostgreSQL fixture lifecycle",()=>{
  it("creates loopback-only disposable admin database and stops on exit",()=>{
    const {result,calls}=invoke();
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("postgresql://matrix_ci_fixture@127.0.0.1:5432/matrix_ci_platform_fixture_admin");
    expect(calls).toContain("--auth-local=trust --auth-host=trust --username=matrix_ci_fixture");
    expect(calls).toContain("-h 127.0.0.1 -p 5432");
    expect(calls).not.toContain("-h 0.0.0.0");
    expect(calls.match(/pg_ctl .* stop/g)).toHaveLength(1);
  });
  it("cleans a started cluster when admin database creation fails",()=>{
    const {result,calls}=invoke("createdb");
    expect(result.status).toBe(42); expect(calls.match(/pg_ctl .* stop/g)).toHaveLength(1);
  });
  it("rejects a privileged fixture process before starting PostgreSQL",()=>{
    const {result,calls}=invoke("root");
    expect(result.status).toBe(64); expect(calls).toBe("");
  });
});
