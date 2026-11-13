// Build-time artifact verification only: no service, account or permission changes.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Inspect the entire archive before extracting a bounded native-relevant subset.
// No regular file is ever written through an archive-provided link.
const extract = String.raw`
import json,os,pathlib,posixpath,shutil,sys,tarfile
archive_path,destination=sys.argv[1:]
MAX_ENTRIES=500000
def diagnostic(code='artifact_archive_rejected',**facts):
    print(json.dumps({'code':code,**facts}),file=sys.stderr)
def reject(code='artifact_archive_rejected',**facts):
    diagnostic(code,**facts)
    raise SystemExit(1)
# Parser/filesystem exceptions never echo archive names or contents into logs.
sys.excepthook=lambda *_:diagnostic()
def safe(name):
    if not name or name.startswith('/') or '\\' in name or '\x00' in name: reject()
    parts=name.rstrip('/').split('/')
    if any(part in ('','..','.') for part in parts): reject()
    return '/'.join(parts)
def selected(name):
    return name in ('release.json','app/package.json','app/TERMINAL_RUNTIME_GENERATION','bin/matrix-terminal-generation-id') or any(name==prefix or name.startswith(prefix+'/') for prefix in ('app/node_modules','app/packages','runtime/node','terminal-runtime'))
with tarfile.open(archive_path,'r:gz') as archive:
    members={}; total=0; entries_seen=0; max_file_bytes=0
    for item in archive:
        entries_seen+=1
        name=safe(item.name)
        if name in members: reject('artifact_archive_duplicate_entry',entriesSeen=entries_seen,uniqueEntries=len(members))
        if len(members)>=MAX_ENTRIES: reject('artifact_archive_entry_limit',entriesSeen=entries_seen,entryLimit=MAX_ENTRIES)
        if item.size<0 or item.size>1024**3: reject('artifact_archive_file_size',entriesSeen=entries_seen,size=item.size,fileSizeLimit=1024**3)
        if not (item.isdir() or item.isreg() or item.issym() or item.islnk()): reject()
        # The unchanged bundler marks runtime tool directories g+s. Extraction
        # recreates directories 0755; setuid/sticky and setgid files stay refused.
        if item.mode & 0o5000 or (item.mode & 0o2000 and not item.isdir()): reject()
        total+=item.size
        max_file_bytes=max(max_file_bytes,item.size)
        if total>20*1024**3: reject()
        members[name]=item
    for name,item in members.items():
        parent=posixpath.dirname(name)
        while parent:
            if parent in members and not members[parent].isdir(): reject()
            parent=posixpath.dirname(parent)
        if item.issym() or item.islnk():
            if not item.linkname or item.linkname.startswith('/') or '\\' in item.linkname: reject()
            target=posixpath.normpath(posixpath.join(posixpath.dirname(name),item.linkname) if item.issym() else item.linkname)
            safe(target)
            if item.islnk() and (target not in members or not members[target].isreg()): reject()
    for name,item in members.items():
        if not selected(name) or item.issym() or item.islnk(): continue
        target=pathlib.Path(destination,name)
        target.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
        if item.isdir(): target.mkdir(mode=0o755,exist_ok=True)
        else:
            source=archive.extractfile(item)
            if source is None: reject()
            with source,open(target,'xb') as output: shutil.copyfileobj(source,output,1024*1024)
            os.chmod(target,item.mode & 0o777)
    for name,item in members.items():
        if not selected(name) or not (item.issym() or item.islnk()): continue
        target=pathlib.Path(destination,name)
        target.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
        if item.issym(): os.symlink(item.linkname,target)
        else: os.link(pathlib.Path(destination,item.linkname),target)
    base=os.path.realpath(destination)+os.sep
    for name,item in members.items():
        if selected(name) and item.issym() and not os.path.realpath(os.path.join(destination,name)).startswith(base): reject()
    print(json.dumps({'entries':entries_seen,'expandedBytes':total,'maxFileBytes':max_file_bytes}))
`;

const nativeProbe = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [app]=process.argv.slice(1);
const runtime={version:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch,libc:'glibc:'+process.report.getReport().header.glibcVersionRuntime};
if(runtime.platform!=='linux'||runtime.arch!=='x64'||runtime.libc!=='glibc:2.39')throw Error('Customer runtime baseline mismatch');
const consumer=await import(pathToFileURL(join(app,'packages/terminal-runtime/dist/zellij-adapter.js')).href);
if(typeof consumer.ZellijCliRuntimeAdapter!=='function')throw Error('Terminal consumer missing');
const require=createRequire(join(app,'package.json'));
const identity=require(join(app,'packages/gateway/dist/collaboration/filesystem-identity.node'));
if(typeof identity.readIdentity!=='function')throw Error('Identity addon missing');
const writer=require(join(app,'packages/gateway/dist/terminal/terminal-writer.node'));
for(const method of ['listen','accept','receive','send','close'])if(typeof writer[method]!=='function')throw Error('Writer addon missing');
const pty=require('node-pty');
let terminal,exited=false;
try{
  await new Promise((accept,reject)=>{
    let output=''; const timer=setTimeout(()=>reject(Error('PTY exit timeout')),5000);
    terminal=pty.spawn('/bin/sh',['-c',"printf 'MATRIX_ARTIFACT_PTY_OK\\n'"],{name:'xterm',cols:80,rows:24,cwd:app,env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME,TERM:'xterm'}});
    terminal.onData(data=>{output+=data;if(output.length>1024){clearTimeout(timer);reject(Error('PTY output limit'));}});
    terminal.onExit(event=>{exited=true;clearTimeout(timer);event.exitCode===0&&output==='MATRIX_ARTIFACT_PTY_OK\r\n'?accept():reject(Error('PTY marker or exit mismatch'));});
  });
}finally{if(terminal&&!exited)terminal.kill();}
console.log(JSON.stringify({...runtime,consumer:true,identity:true,writer:true,pty:true,ptyExited:exited}));
`;

const generationProbe = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [directory,generation]=process.argv.slice(1);
const {assertPinnedTerminalRuntime}=await import(pathToFileURL(join(directory,'generation-closure.mjs')).href);
const manifest=await assertPinnedTerminalRuntime(directory,generation);
if(manifest.runtime.platform!=='linux'||manifest.runtime.arch!=='x64'||manifest.runtime.libc!=='glibc:2.39')throw Error('Generation customer baseline mismatch');
const require=createRequire(join(directory,'node'));
require(join(directory,'node_modules/node-pty/lib/index.js'));
const writer=require(join(directory,'terminal-writer.node'));
for(const method of ['listen','accept','receive','send','close'])if(typeof writer[method]!=='function')throw Error('Generation writer missing');
console.log(JSON.stringify({generation,pinnedRuntime:true,pty:true,writer:true,runtime:manifest.runtime}));
`;

function failure(code, cause) { const error = new Error(code, { cause }); error.code = code; return error; }
function archiveFailure(stderr) {
  const fields = {
    artifact_archive_rejected: [],
    artifact_archive_duplicate_entry: ["entriesSeen", "uniqueEntries"],
    artifact_archive_entry_limit: ["entriesSeen", "entryLimit"],
    artifact_archive_file_size: ["entriesSeen", "size", "fileSizeLimit"],
  };
  let value;
  try { value = JSON.parse(stderr); }
  catch (error) { if (error instanceof SyntaxError) return failure("artifact_archive_rejected"); throw error; }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.code !== "string" || !Object.hasOwn(fields, value.code)) return failure("artifact_archive_rejected");
  const error = failure(value.code);
  error.archive = Object.fromEntries(fields[value.code].filter(key => Number.isSafeInteger(value[key])).map(key => [key, value[key]]));
  return error;
}
function run(command, args, options, code) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 65_536, ...options });
  if (result.error || result.status !== 0) {
    if (code === "artifact_archive_rejected") throw archiveFailure(result.stderr);
    throw failure(code, result.error ?? new Error(result.stderr || `exit ${result.status}`));
  }
  return result.stdout.trim();
}
async function regular(path) {
  const info = await stat(path);
  if (!info.isFile() || await realpath(path) !== path) throw failure("artifact_payload_incomplete");
}
async function metadata(path, limit) {
  if ((await stat(path)).size > limit) throw failure("artifact_provenance_invalid");
  return readFile(path, "utf8");
}
function archiveInventory(stdout) {
  const value = JSON.parse(stdout);
  const keys = ["entries", "expandedBytes", "maxFileBytes"];
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    || keys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) throw failure("artifact_archive_rejected");
  return value;
}

export async function smokeHostBundleNative(bundlePath) {
  const info = await stat(bundlePath);
  if (!info.isFile() || info.size > 4 * 1024 ** 3) throw failure("artifact_archive_rejected");
  const work = await realpath(await mkdtemp(join(tmpdir(), "matrix-host-native-smoke-")));
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work, NODE_ENV: "production" };
  let archive;
  try {
    archive = archiveInventory(run("python3", ["-c", extract, resolve(bundlePath), work], { env, timeout: 180_000 }, "artifact_archive_rejected"));
    const app = join(work, "app"), node = join(work, "runtime/node/bin/node");
    try {
      for (const file of [node, join(work, "release.json"), join(app, "package.json"), join(app, "TERMINAL_RUNTIME_GENERATION"),
        join(app, "packages/terminal-runtime/dist/zellij-adapter.js"), join(app, "packages/gateway/dist/collaboration/filesystem-identity.node"),
        join(app, "packages/gateway/dist/terminal/terminal-writer.node"), join(work, "bin/matrix-terminal-generation-id")]) await regular(file);
    } catch (error) {
      if (error instanceof Error && ["ENOENT", "ENOTDIR", "EACCES", "artifact_payload_incomplete"].includes(error.code)) throw failure("artifact_payload_incomplete");
      throw error;
    }
    const release = JSON.parse(await metadata(join(work, "release.json"), 16_384));
    if (!/^[a-f0-9]{40}$/.test(release.gitCommit) || typeof release.version !== "string" || release.version.length > 160
      || (process.env.MATRIX_BUILD_SHA && release.gitCommit !== process.env.MATRIX_BUILD_SHA)) throw failure("artifact_provenance_invalid");
    const generation = (await metadata(join(app, "TERMINAL_RUNTIME_GENERATION"), 256)).trim();
    if (!/^gen_[a-f0-9]{64}$/.test(generation)) throw failure("artifact_generation_invalid");
    const directory = join(work, "terminal-runtime/generations", generation);
    await regular(join(directory, "node"));
    const actualGeneration = run("/bin/bash", [join(work, "bin/matrix-terminal-generation-id"), join(directory, "zellij"),
      join(directory, "matrix-terminal-user-keeper.mjs"), join(directory, "matrix-terminal-attach.mjs")], { env }, "artifact_generation_invalid");
    if (actualGeneration !== generation) throw failure("artifact_generation_invalid");
    // Reuse the existing ELF/load gate, with no ambient loader or account env.
    run(process.execPath, [fileURLToPath(new URL("./verify-host-native-abi.mjs", import.meta.url)), app, node], { env }, "artifact_native_abi_failed");
    // Match matrix-terminal-runtime's compiled dist/service.js path: bare Node.
    // Gateway's tsx loader and the Terminal source fallback are separate paths.
    const native = JSON.parse(run(node, ["--input-type=module", "-e", nativeProbe, app], { cwd: app, env }, "artifact_native_consumer_failed"));
    const pinned = JSON.parse(run(join(directory, "node"), ["--input-type=module", "-e", generationProbe, directory, generation],
      { cwd: directory, env }, "artifact_pinned_runtime_failed"));
    if (["version", "modules", "napi", "platform", "arch", "libc"].some(key => native[key] !== pinned.runtime[key])) throw failure("artifact_pinned_runtime_failed");
    return { version: 1, kind: "host-bundle-native-smoke", buildVersion: release.version, gitCommit: release.gitCommit, archive, native, pinned };
  } catch (error) {
    if (!error.archive && archive) error.archive = archive;
    throw error;
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error(JSON.stringify({ ok: false, code: "usage", usage: "smoke-host-bundle-native.mjs <bundle.tar.gz>" })); process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify({ ok: true, ...await smokeHostBundleNative(process.argv[2]) })); }
    catch (error) {
      // Build diagnostics only, from the fixed probes and a credential-free child env.
      console.error(JSON.stringify({ ok: false, code: error.code ?? "artifact_native_smoke_failed", archive: error.archive, detail: error.cause?.message?.slice(0, 4096) })); process.exitCode = 1;
    }
  }
}
