"""Publish a verified complete Hermes source artifact; never prune a live tree.

Only managed source is exchanged. Original source, failed artifacts and audit
records are retained; owner data and PM generations are never rewritten.
"""
from __future__ import annotations
import argparse
import contextlib
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

MEMBER = "node_modules/flatted/python/flatted.py"
CACHE = re.compile(r"(?:^|/)__pycache__/[^/]+\.cpython-\d+(?:\.opt-\d+)?\.pyc$")
@dataclass(frozen=True)
class Policy:
    commit: str
    member_hash: str
    member_size: int
    integrity: str
    version: str = "3.4.4"
DEFAULT = Policy("e06df9c2eae6901f4c88f464e0ae6e753c0428b8",
    "f784c254de76a25435ebaa61c72942072733ae4b42619b943bf37b09fa45e644",3773,
    "sha512-5+ybhBZANEJxaH3X5evAFatUxLfEHSr7n6kYJ+1Qd0mUqr4eu9gIf6GDbWHf8RJijHrjjO8G+la14SlL2SeS1Q==")
class ArtifactError(RuntimeError): pass

def _identity(path):
    value = Path(path).lstat()
    return [str(value.st_dev), str(value.st_ino)]

def _regular_bytes(path, limit=1024*1024):
    before = Path(path).lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        raise ArtifactError("Metadata is not a bounded regular file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd,"rb") as stream:
        opened = os.fstat(stream.fileno())
        data = stream.read(limit+1)
        after = os.fstat(stream.fileno())
    def token(v): return (v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns)
    if token(before)!=token(opened) or token(opened)!=token(after) or len(data)!=before.st_size:
        raise ArtifactError("Input changed while reading")
    return data

def _json(path):
    try: return json.loads(_regular_bytes(path))
    except (OSError,ValueError) as error: raise ArtifactError("Invalid artifact metadata") from error

def _write_json(path, value):
    temporary = path.with_name(path.name+".tmp-"+uuid.uuid4().hex)
    with temporary.open("x",encoding="utf8") as stream:
        json.dump(value,stream,sort_keys=True,ensure_ascii=True)
        stream.write("\n");stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)
    directory = os.open(path.parent,os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)

def _directory(path):
    if path.is_symlink(): raise ArtifactError("Artifact directory is aliased")
    if not path.exists(): path.mkdir(mode=0o700)
    info=path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid():
        raise ArtifactError("Artifact directory is not owned by this runtime user")
    return path

def _source(path):
    value=Path(path).expanduser()
    if value.name!="hermes-agent": raise ArtifactError("Expected managed Hermes source directory")
    value=value.parent.resolve(strict=True)/value.name
    if value.is_symlink(): raise ArtifactError("Source aliases are not publication targets")
    if value.exists() and (not value.is_dir() or value.stat().st_uid!=os.geteuid()):
        raise ArtifactError("Source directory is not owned by this runtime user")
    return value

@contextlib.contextmanager
def _lock(path):
    fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): raise ArtifactError("Invalid publication lock")
        try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError as error: raise ArtifactError("Another Hermes operation owns the checkout") from error
        yield
    finally: os.close(fd)

@contextlib.contextmanager
def _checkout_lock(root):
    directory=root/".git"
    if not stat.S_ISDIR(directory.lstat().st_mode) or (directory/"commondir").exists():
        raise ArtifactError("A standalone verified checkout is required")
    with _lock(directory/"hermes-update.lock"): yield

def _git(root,*args):
    env={"PATH":"/usr/bin:/bin","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null",
         "GIT_OPTIONAL_LOCKS":"0","GIT_TERMINAL_PROMPT":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_NO_LAZY_FETCH":"1"}
    def cap(): resource.setrlimit(resource.RLIMIT_FSIZE,(4*1024*1024,4*1024*1024))
    with tempfile.TemporaryFile() as output,tempfile.TemporaryFile() as errors:
        result=subprocess.run(["/usr/bin/git","--no-pager","-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","-C",str(root),*args],
            env=env,stdout=output,stderr=errors,timeout=60,preexec_fn=cap)
        if result.returncode: raise ArtifactError("Pinned source verification failed")
        output.seek(0);return output.read(4*1024*1024)

def _validate(root,policy,full):
    if not stat.S_ISDIR((root/".git").lstat().st_mode): raise ArtifactError("A standalone verified checkout is required")
    for parent,_,files in os.walk(root/".git",followlinks=False):
        if any(name.endswith(".lock") and Path(parent)/name!=root/".git/hermes-update.lock" for name in files):
            raise ArtifactError("A Git writer has not completed; source retained")
    if _git(root,"rev-parse","HEAD").decode().strip()!=policy.commit: raise ArtifactError("Unexpected source commit")
    _git(root,"diff","--quiet","--no-ext-diff","--no-textconv","HEAD","--")
    lock=_json(root/"package-lock.json");package=lock.get("packages",{}).get("node_modules/flatted",{})
    if package.get("version")!=policy.version or package.get("integrity")!=policy.integrity:
        raise ArtifactError("Unexpected flatted package lock")
    if _json(root/"node_modules/flatted/package.json").get("version")!=policy.version:
        raise ArtifactError("Unexpected installed flatted version")
    for ignored in (False,True):
        paths=_git(root,"ls-files","--others",*( ["--ignored"] if ignored else []),"--exclude-standard","-z","--",
                   "*.py","*.pyc","*.pyo","*.pth","*.so","*.zip",":(exclude)venv/**",":(exclude,glob)**/__pycache__/*.cpython-*.pyc")
        for raw in paths.split(b"\0"):
            path=os.fsdecode(raw)
            if path and not CACHE.search(path) and not (full and path==MEMBER):
                raise ArtifactError("Unexpected importable source addition")
    member=root/MEMBER
    if full:
        current=root
        for component in Path(MEMBER).parts:
            current=current/component
            if current.is_symlink(): raise ArtifactError("Curation member must not be symlinked")
        info=member.lstat()
        data=_regular_bytes(member,policy.member_size)
        if info.st_nlink!=1 or len(data)!=policy.member_size or hashlib.sha256(data).hexdigest()!=policy.member_hash:
            raise ArtifactError("Unexpected curation member bytes")
    elif member.exists() or member.is_symlink(): raise ArtifactError("Artifact still contains the omitted member")
    for relative in ("ui-tui/dist/entry.js","hermes_cli/web_dist/index.html"):
        info=(root/relative).lstat()
        if not stat.S_ISREG(info.st_mode) or not info.st_size: raise ArtifactError("Compiled frontend is missing")

def _legacy_python_link(root,path,relative):
    # The retained legacy venv is already a separate dependency boundary. Only
    # standard interpreter links may point out of it; source/import links may not.
    environment=root/"venv"
    if path.parent!=environment/"bin": return False
    if environment.resolve()!=environment or (environment/"bin").resolve()!=environment/"bin": return False
    _regular_bytes(environment/"pyvenv.cfg")
    target=path.resolve(strict=True)
    if target!=(environment/"bin/python").resolve(strict=True): return False
    info=target.stat()
    return stat.S_ISREG(info.st_mode) and info.st_uid in (0,os.geteuid()) and not info.st_mode&0o022 and os.access(target,os.X_OK)

def _snapshot(root):
    entries={};size=0
    for parent,dirs,files in os.walk(root,followlinks=False):
        if Path(parent)==root: dirs[:]=[name for name in dirs if name!=".git"]
        for name in sorted(dirs+files):
            path=Path(parent)/name;relative=path.relative_to(root).as_posix()
            if CACHE.search(relative): continue
            info=path.lstat();mode=stat.S_IMODE(info.st_mode)
            if stat.S_ISLNK(info.st_mode):
                if not path.resolve().is_relative_to(root) and not _legacy_python_link(root,path,relative):
                    raise ArtifactError("Source link escapes artifact")
                value={"kind":"link","mode":mode,"target":os.readlink(path)}
            elif stat.S_ISDIR(info.st_mode): value={"kind":"directory","mode":mode}
            elif stat.S_ISREG(info.st_mode):
                if info.st_size>256*1024*1024: raise ArtifactError("Source member exceeds size budget")
                fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                digest=hashlib.sha256();count=0
                with os.fdopen(fd,"rb") as stream:
                    opened=os.fstat(stream.fileno())
                    for chunk in iter(lambda:stream.read(1024*1024),b""):
                        count+=len(chunk)
                        if count>256*1024*1024: raise ArtifactError("Source member grew beyond budget")
                        digest.update(chunk)
                    final=os.fstat(stream.fileno())
                token=lambda v:(v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns)
                if token(info)!=token(opened) or token(opened)!=token(final) or count!=info.st_size:
                    raise ArtifactError("Source member changed while hashing")
                value={"kind":"file","mode":mode,"size":info.st_size,"sha256":digest.hexdigest()};size+=info.st_size
            else: raise ArtifactError("Unsupported artifact member")
            entries[relative]=value
            if len(entries)>200000 or size>8*1024**3: raise ArtifactError("Source artifact exceeds budget")
    digest=hashlib.sha256(json.dumps(entries,sort_keys=True).encode()).hexdigest()
    return entries,digest,size

def _copy_budget(root):
    # copytree includes Git metadata and harmless caches excluded from the
    # runtime digest. Account for those plus allocation rounding, manifests
    # and transient copy overhead without consuming the 4.5 GiB reserve.
    allocation=4096;count=0
    for parent,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            info=(Path(parent)/name).lstat();count+=1
            allocation+=max(4096,((info.st_size+4095)//4096)*4096,info.st_blocks*512)
            if count>200000 or allocation>8*1024**3:
                raise ArtifactError("Complete source copy exceeds storage budget")
    return 2*allocation+int(4.5*1024**3)

def _facts(root):
    key=hashlib.sha256(str(root).encode()).hexdigest()[:16]
    state=root.parent/"installs"/key
    if state.resolve()!=state: raise ArtifactError("PM completion state is aliased")
    return hashlib.sha256(_regular_bytes(state/"facts.json")).hexdigest()

def _paths(root,record,state):
    if record.get("source")!=str(root): raise ArtifactError("Transaction belongs to another source")
    token=record.get("id","")
    if not re.fullmatch(r"[a-f0-9]{32}",token): raise ArtifactError("Invalid transaction identity")
    stage=state/("stage-"+token);backup=state/("full-"+token)
    if record.get("backup")!=str(backup): raise ArtifactError("Invalid rollback path")
    for path in (stage,backup):
        if path.is_symlink(): raise ArtifactError("Transaction paths are aliased")
    return stage,backup

def _archive_transaction(state,record,status):
    record={**record,"status":status}
    _write_json(state/"transaction.json",record)
    history=_directory(state/"history")
    os.rename(state/"transaction.json",history/(record["id"]+"-"+uuid.uuid4().hex+".json"))

def _recover(root,state):
    journal=state/"transaction.json"
    if not journal.exists(): return {"recovered":False}
    record=_json(journal);stage,backup=_paths(root,record,state)
    if root.exists() and _identity(root)==record["originalIdentity"]:
        _archive_transaction(state,record,"original-intact")
        return {"recovered":False}
    if not backup.exists() or _identity(backup)!=record["originalIdentity"]:
        raise ArtifactError("Interrupted publication is ambiguous; inputs retained")
    with _checkout_lock(backup):
        if not root.exists():
            os.rename(backup,root);_archive_transaction(state,record,"restored")
            return {"recovered":True}
        if _identity(root)!=record["artifactIdentity"]:
            raise ArtifactError("Source changed after interruption; inputs retained")
        with _checkout_lock(root):
            if _snapshot(root)[1]!=record["artifactDigest"] or _facts(root)!=record["pmFactsSHA256"]:
                raise ArtifactError("Interrupted artifact changed; inputs retained")
            if _git(root,"rev-parse","HEAD").decode().strip()!=record["commit"]:
                raise ArtifactError("Interrupted source identity changed; inputs retained")
            _git(root,"diff","--quiet","--no-ext-diff","--no-textconv","HEAD","--")
            _write_json(state/"current.json",{**record,"status":"committed"})
            _archive_transaction(state,record,"committed")
            return {"recovered":True,"committed":True}

def recover(source):
    try:
        root=_source(source);state=root.parent/".matrix-runtime-artifacts"
        if not state.exists(): return {"recovered":False}
        _directory(state)
        with _lock(state/"publish.lock"): return _recover(root,state)
    except ArtifactError: raise
    except (OSError,ValueError,KeyError,subprocess.SubprocessError) as error: raise ArtifactError("Source recovery failed; inputs retained") from error

def publish(source,policy=DEFAULT):
    root=_source(source);state=_directory(root.parent/".matrix-runtime-artifacts")
    try:
        with _lock(state/"publish.lock"):
            _recover(root,state)
            with _checkout_lock(root):
                if not (root/MEMBER).exists() and (state/"current.json").exists():
                    current=_json(state/"current.json");_paths(root,current,state);_validate(root,policy,False)
                    if current.get("commit")!=policy.commit or current.get("memberHash")!=policy.member_hash or _snapshot(root)[1]!=current["artifactDigest"]:
                        raise ArtifactError("Managed artifact changed; explicit rebuild required")
                    if not Path(current["backup"]).is_dir(): raise ArtifactError("Rollback input is missing")
                    return {**current,"alreadyCurrent":True}
                _validate(root,policy,True);before,digest,_=_snapshot(root);facts=_facts(root)
                if shutil.disk_usage(root.parent).free < _copy_budget(root):
                    raise ArtifactError("Insufficient space to retain verified rollback input")
                token=uuid.uuid4().hex;stage=_directory(state/("stage-"+token));candidate=stage/"source";backup=state/("full-"+token)
                def ignore(parent,names):
                    omitted=[]
                    if Path(parent)==root/"node_modules/flatted/python": omitted.append("flatted.py")
                    if Path(parent)==root/".git": omitted.append("hermes-update.lock")
                    return omitted
                shutil.copytree(root,candidate,symlinks=True,ignore=ignore)
                if _snapshot(root)[0]!=before or _facts(root)!=facts: raise ArtifactError("Input changed during artifact preparation")
                _validate(root,policy,True);_validate(candidate,policy,False)
                after,artifact_digest,_=_snapshot(candidate);expected=dict(before);del expected[MEMBER]
                if after!=expected: raise ArtifactError("Unexpected curated artifact difference")
                _write_json(stage/"full-manifest.json",before);_write_json(stage/"curated-manifest.json",after)
                with _checkout_lock(candidate):
                    record={"schema":1,"id":token,"source":str(root),"backup":str(backup),"commit":policy.commit,
                            "memberHash":policy.member_hash,"inputDigest":digest,"artifactDigest":artifact_digest,
                            "originalIdentity":_identity(root),"artifactIdentity":_identity(candidate),"pmFactsSHA256":facts,"status":"prepared"}
                    _write_json(state/"transaction.json",record)
                    try:
                        os.rename(root,backup);os.rename(candidate,root)
                        if _snapshot(root)[1]!=artifact_digest or _facts(root)!=facts: raise ArtifactError("Published artifact changed")
                        _validate(root,policy,False)
                        result={**record,"status":"committed","alreadyCurrent":False}
                        _write_json(state/"current.json",result);_archive_transaction(state,record,"committed")
                        return result
                    except Exception as error:
                        if backup.exists():
                            if root.exists():
                                if _identity(root)!=record["artifactIdentity"]: raise ArtifactError("Publication changed unexpectedly; inputs retained") from error
                                os.rename(root,state/("failed-"+token))
                            os.rename(backup,root)
                            _archive_transaction(state,record,"rolled-back")
                        raise ArtifactError("Source publication failed; original restored or retained") from error
    except ArtifactError: raise
    except (OSError,ValueError,KeyError,subprocess.SubprocessError) as error:
        raise ArtifactError("Source artifact preparation failed; inputs retained") from error

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("source");parser.add_argument("--recover",action="store_true");args=parser.parse_args()
    try: print(json.dumps(recover(args.source) if args.recover else publish(args.source),sort_keys=True))
    except ArtifactError as error:
        print("matrix-hermes-runtime: "+str(error),file=sys.stderr);raise SystemExit(1)
