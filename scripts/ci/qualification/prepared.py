"""Exact-lock image cache selection before any candidate package code executes."""
import base64,hashlib,os,re,shutil,stat,sys,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from common import decode_json,digest,read_regular
from manifest import load_manifest,sha
IMAGE_UID=0
MAX_LOCK=20*1024*1024
MAX_STORE_BYTES=32*1024*1024*1024
MAX_STORE_ENTRIES=500000


def image_path(image,relative,directory=False):
 current=Path(image)
 for component in (None,*Path(relative).parts):
  if component is not None:current=current/component
  info=current.lstat()
  if info.st_uid!=IMAGE_UID or stat.S_ISLNK(info.st_mode):raise ValueError('Unexpected image cache authority')
  if current!=Path(image)/relative or directory:
   if not stat.S_ISDIR(info.st_mode):raise ValueError('Unexpected image cache directory')
  elif not stat.S_ISREG(info.st_mode):raise ValueError('Unexpected image cache file')
 return current


def sri(value):
 if not isinstance(value,str) or not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==',value):raise ValueError('Unsupported cache integrity')
 decoded=base64.b64decode(value[7:],validate=True)
 if len(decoded)!=64:raise ValueError('Invalid cache integrity size')
 return decoded


def browser_ready(lock,image):
 """Use pnpm10 v10 readonly metadata, never candidate node_modules/imports."""
 entries=re.findall(rb'^  playwright-core@([0-9]+\.[0-9]+\.[0-9]+):\n    resolution: \{integrity: (sha512-[A-Za-z0-9+/]+=+)\}',lock,re.M)
 if not 1<=len(entries)<=4 or len({v for v,_ in entries})!=len(entries):return False
 for version,integrity in entries:
  version=version.decode();key=sri(integrity.decode()).hex()[:64]
  index=image_path(image,'pnpm-store/v10/index/'+key[:2]+'/'+key[2:]+'-playwright-core@'+version+'.json')
  package=decode_json(read_regular(index,2*1024*1024))
  if not isinstance(package,dict) or package.get('name')!='playwright-core' or package.get('version')!=version:raise ValueError('Prepared browser package differs')
  entry=package['files']['browsers.json']
  if not isinstance(entry,dict):raise ValueError('Invalid browser content metadata')
  content_hash=sri(entry['integrity']);hex_hash=content_hash.hex()
  if entry.get('mode')!=0o644 or type(entry.get('size')) is not int or not 0<entry['size']<=65536:raise ValueError('Prepared browser metadata bounds differ')
  content=read_regular(image_path(image,'pnpm-store/v10/files/'+hex_hash[:2]+'/'+hex_hash[2:]),65536)
  if len(content)!=entry['size'] or hashlib.sha512(content).digest()!=content_hash:raise ValueError('Prepared browser metadata integrity differs')
  browsers=decode_json(content)['browsers']
  if not isinstance(browsers,list) or len(browsers)>32:raise ValueError('Prepared browser metadata inventory differs')
  for name in ('chromium','chromium-headless-shell','ffmpeg'):
   matches=[b for b in browsers if isinstance(b,dict) and b.get('name')==name]
   if len(matches)!=1:raise ValueError('Required browser metadata missing')
   browser=matches[0];overrides=browser.get('revisionOverrides',{})
   if not isinstance(overrides,dict):raise ValueError('Invalid browser revision overrides')
   revision=overrides.get('ubuntu24.04-x64',browser.get('revision'))
   if not isinstance(revision,str) or not re.fullmatch('[0-9]{1,10}',revision):raise ValueError('Invalid browser revision')
   path='browsers/'+name.replace('-','_')+'-'+revision
   image_path(image,path,directory=True);read_regular(image_path(image,path+'/INSTALLATION_COMPLETE'),4096)
 return True


def copy_store(image,destination):
 """Copy content/index only, with new inodes; never share virtual node_modules."""
 destination=Path(destination);destination.mkdir(exist_ok=False)
 deadline=time.monotonic()+120;entries=total=0
 for folder in ('files','index'):
  origin=image_path(image,'pnpm-store/v10/'+folder,directory=True)
  for current,dirs,files in os.walk(origin,followlinks=False):
   target=destination/'v10'/folder/Path(current).relative_to(origin);target.mkdir(parents=True,exist_ok=True)
   for name in (*dirs,*files):
    entries+=1
    if entries>MAX_STORE_ENTRIES or time.monotonic()>deadline:raise ValueError('Prepared store copy bounds exceeded')
    path=Path(current)/name;info=path.lstat()
    if info.st_uid!=IMAGE_UID or stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):raise ValueError('Unexpected prepared store content')
    if name in files:
     total+=info.st_size
     if total>MAX_STORE_BYTES or info.st_size>512*1024*1024:raise ValueError('Prepared store byte bound exceeded')
     shutil.copyfile(path,target/name,follow_symlinks=False)
     shutil.copymode(path,target/name,follow_symlinks=False)


def select_cache(inventory,lockfile,image,destination):
 lock=read_regular(lockfile,MAX_LOCK)
 if digest(lock)!=inventory['lockSha256']:raise ValueError('Trusted source lockfile differs')
 try:
  pin=read_regular(image_path(image,'prepared-lock.sha256'),65).decode('ascii')
  if pin!=inventory['lockSha256']+'\n':return 'cold'
  for folder in ('files','index'):image_path(image,'pnpm-store/v10/'+folder,directory=True)
 except (OSError,ValueError,UnicodeError):return 'cold'
 # Missing/incompatible browser cache still permits exact-lock content reuse.
 try:ready=browser_ready(lock,image)
 except (OSError,ValueError,KeyError,TypeError):ready=False
 copy_store(image,destination)
 return 'store-browsers' if ready else 'store'


def prepare(source,filename,manifest_sha,lockfile,image,destination):
 inventory=load_manifest(filename,manifest_sha)
 if sha(source)!=inventory['source']:raise ValueError('Manifest merge source differs')
 return select_cache(inventory,lockfile,image,destination)


if __name__=='__main__':
 if len(sys.argv)!=4 or sys.argv[2]!='/work/qualification-input.json':raise SystemExit('Invalid prepared cache request')
 try:print(prepare(*sys.argv[1:],Path('/work/unit/pnpm-lock.yaml'),Path('/opt/matrix-ci'),Path('/work/pnpm-store')))
 except (OSError,ValueError):
  print('Prepared cache setup rejected',file=sys.stderr);sys.exit(1)
