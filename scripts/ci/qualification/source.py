"""UID10001 public source checkout, isolated lanes and strict source guards."""
import hashlib,json,os,stat,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from common import git_command,read_regular,write_json,digest,decode_json,canonical
from manifest import load_manifest,sha
from contract import LANES,CONFIGS
from coverage import coverage
from integrity import actual_inventory,git_policy
SOURCE=None
TREE=None
LOCK=None
UNIT_IMPORTS={}
TRACKED={}
TRACKED_DIGEST=None
INVENTORY_DIGEST=None
MAX_SOURCE_PATHS=512
SOURCE_ROOTS={lane:'/work/'+lane for lane in LANES}

def configure(inventory):
 global SOURCE,TREE,LOCK,UNIT_IMPORTS,TRACKED,TRACKED_DIGEST,INVENTORY_DIGEST
 SOURCE,TREE,LOCK=inventory['source'],inventory['tree'],inventory['lockSha256']
 UNIT_IMPORTS=inventory['unitImports']
 TRACKED,TRACKED_DIGEST=inventory['tracked'],inventory['trackedInventorySha256']
 INVENTORY_DIGEST=digest(canonical(inventory)+b'\n')

def checkout_verified(run,inventory):
 source=sha(inventory['source'])
 run(['fetch','--depth=2','origin',source+':refs/ci/source'])
 run(['checkout','--detach',source])
 if run(['rev-parse','HEAD']).strip()!=source or run(['rev-parse','HEAD^{tree}']).strip()!=inventory['tree'] or run(['show','-s','--format=%P','HEAD']).strip()!=' '.join(inventory['parents']):raise ValueError('Public merge source/tree/parents differ')

def clone_lanes(work):
 for lane in ('mechanical','web','e2e'):
  git_command(work,['clone','--no-hardlinks','--no-checkout',str(work/'unit'),str(work/lane)])
  git_command(work/lane,['checkout','--detach',SOURCE])
  if git_command(work/lane,['rev-parse','HEAD']).strip()!=SOURCE:raise ValueError('Independent lane source differs')

def prepare_source(inventory):
 if os.getuid()!=10001:raise ValueError('Source preparation requires isolated runner UID')
 root=Path('/work/unit');root.mkdir(mode=0o755)
 git=lambda args:git_command(root,args)
 git(['init']);git(['remote','add','origin','https://github.com/HamedMP/matrix-os.git'])
 checkout_verified(git,inventory)
 if digest(read_regular(root/'pnpm-lock.yaml',2*1024*1024))!=LOCK:raise ValueError('Source lock differs')
 for name in CONFIGS:
  if git(['hash-object',name]).strip()!=inventory['configBlobs'][name] or digest(read_regular(root/name,256*1024))!=inventory['configSha256'][name]:raise ValueError('Source config differs')
 clone_lanes(Path('/work'))

def prepare_unit_source(root):
 # Isolated Python (-I) ignores bytecode-cache environment variables. Lease
 # only this tracked directory as readonly before any unit test starts; Python
 # tolerates denied bytecode writes. File contents/modes and Git rules stay exact.
 root=Path(root)
 if root.name!='unit':raise ValueError('Expected fixed unit checkout')
 flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK
 descriptors=[]
 try:
  fd=os.open(root,flags);descriptors.append(fd)
  if os.fstat(fd).st_uid!=os.getuid():raise ValueError('Expected owned source checkout')
  for name in ('scripts','ops'):
   fd=os.open(name,flags,dir_fd=fd);descriptors.append(fd)
   info=os.fstat(fd)
   if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid():raise ValueError('Expected owned source directory')
  if git_command(root,['rev-parse','HEAD']).strip()!=SOURCE:raise ValueError('Unit source checkout differs')
  for args in (['diff','--no-ext-diff','--name-only','-z','HEAD','--','scripts/ops'],['diff','--cached','--no-ext-diff','--name-only','-z','HEAD','--','scripts/ops']):
   if git_command(root,args):raise ValueError('Tracked source imports differ')
  try:os.stat('__pycache__',dir_fd=fd,follow_symlinks=False)
  except FileNotFoundError:pass # Explicit expected absence; never delete caches.
  else:raise ValueError('Source bytecode cache already exists')
  for name,entry in UNIT_IMPORTS.items():
   digest,mode=entry['sha256'],entry['mode']
   file=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
   with os.fdopen(file,'rb') as stream:
    info=os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_size>256*1024 or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=mode:raise ValueError('Source import file mode/type differs')
    content=stream.read(256*1024+1)
    if hashlib.sha256(content).hexdigest()!=digest:raise ValueError('Source import bytes differ')
  os.fchmod(fd,0o555)
  if stat.S_IMODE(os.fstat(fd).st_mode)!=0o555:raise ValueError('Source lease mode differs')
 finally:
  for fd in reversed(descriptors):os.close(fd)


def check_source(root,output,stage,lane):
 # Never restore generated changes or relax source Git's ignore/buffer rules.
 # This bounded diagnostic is written even when the guard rejects the checkout.
 import json
 if lane not in SOURCE_ROOTS or stage not in ('postinstall','after-prerequisites','before-desktop','before-release','after-lane','host-final'):raise ValueError('Invalid provenance phase')
 evidence=dict(lane=lane,stage=stage,source=SOURCE,clean=False,tracked=[],untracked=[],trackedInventorySha256=TRACKED_DIGEST,inventorySha256=INVENTORY_DIGEST,trackedIntegrityClean=False,indexMatches=False,indexFlagsClean=False,ignorePolicyClean=False);read_error=None
 try:
  try:
   evidence.update(actual_inventory(root,TRACKED))
   evidence['trackedIntegrityClean']=evidence['actualTrackedInventorySha256']==TRACKED_DIGEST
  except (ValueError,OSError) as error:
   read_error=error;evidence['integrityError']='tracked_read_failed'
  try:evidence.update(git_policy(root,TRACKED))
  except (ValueError,RuntimeError,OSError) as error:
   read_error=error;evidence['integrityError']='index_ignore_policy_failed'
  evidence['actualSource']=git_command(root,['rev-parse','HEAD']).strip()
  evidence['lockSha256']=hashlib.sha256(read_regular(Path(root)/'pnpm-lock.yaml',2*1024*1024)).hexdigest()
  evidence['lockMatches']=evidence['lockSha256']==LOCK
  def paths(args):
   raw=git_command(root,args)
   values=raw.split('\0')[:-1] if raw else []
   if len(values)>MAX_SOURCE_PATHS or len(raw.encode('utf8'))>256*1024 or any(len(v.encode('utf8'))>4096 for v in values):raise ValueError('path_bound')
   return values
  evidence['tracked']=sorted(set(paths(['diff','--no-ext-diff','--name-only','-z','HEAD','--'])+paths(['diff','--cached','--no-ext-diff','--name-only','-z','HEAD','--'])))
  if len(evidence['tracked'])>MAX_SOURCE_PATHS:raise ValueError('path_bound')
  evidence['untracked']=paths(['ls-files','--others','--exclude-standard','-z'])
  evidence['trackedPathsSha256']=hashlib.sha256(json.dumps(evidence['tracked'],separators=(',',':')).encode()).hexdigest()
  evidence['untrackedPathsSha256']=hashlib.sha256(json.dumps(evidence['untracked'],separators=(',',':')).encode()).hexdigest()
  evidence['clean']=evidence['trackedIntegrityClean'] and evidence['indexMatches'] and evidence['indexFlagsClean'] and evidence['ignorePolicyClean'] and evidence['actualSource']==SOURCE and evidence['lockMatches'] and not evidence['tracked'] and not evidence['untracked']
 except Exception as error:
  read_error=error
  # Bound messages and keep actual path evidence only in the accepted JSON.
  evidence['error']='path_bound' if str(error)=='path_bound' else 'provenance_read_failed'
  print('Source provenance diagnostic rejected: '+evidence['error'],file=sys.stderr)
 encoded=canonical(evidence)+b'\n'
 if len(encoded)>256*1024:
  evidence.update(clean=False,error='evidence_bound',tracked=[],untracked=[])
  encoded=canonical(evidence)+b'\n'
 if output is None:sys.stdout.buffer.write(encoded)
 else:
  with open(output,'xb') as file:file.write(encoded)
 if not evidence['clean']:raise ValueError('Source provenance rejected for '+lane+' '+stage) from read_error
 return evidence


if __name__=='__main__':
 if len(sys.argv)<4:raise SystemExit('Expected source SHA, fixed manifest path/digest and mode')
 source,filename,manifest_sha,*mode=sys.argv[1:]
 if filename!='/work/qualification-input.json':raise SystemExit('Unexpected manifest path')
 inventory=load_manifest(filename,manifest_sha)
 if sha(source)!=inventory['source']:raise ValueError('Manifest merge source differs')
 configure(inventory)
 if mode==['--prepare']:prepare_source(inventory)
 elif mode==['--prepare-unit-source']:prepare_unit_source(Path('/work/unit'))
 elif len(mode)==3 and mode[0]=='--source-check':
  lane,stage=mode[1:]
  if lane not in SOURCE_ROOTS:raise ValueError('Unknown source lane')
  check_source(Path(SOURCE_ROOTS[lane]),Path('/work/results')/('source-'+lane+'-'+stage+'.json'),stage,lane)
 elif len(mode)==2 and mode[0]=='--host-final-check':
  lane=mode[1]
  if lane not in SOURCE_ROOTS:raise ValueError('Unknown host source lane')
  try:check_source(Path(SOURCE_ROOTS[lane]),None,'host-final',lane)
  except ValueError:
   print('Independent final source integrity rejected',file=sys.stderr);sys.exit(1)
 elif mode==['--coverage']:
  result=coverage(decode_json(read_regular('/work/results/unit.json',50*1024*1024)),inventory['unit'],'unit')
  result.update(source=SOURCE,tree=TREE,inventorySha256=manifest_sha)
  write_json('/work/results/coverage.json',result)
 else:raise SystemExit('Unknown source proof mode')
