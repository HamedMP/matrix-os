"""Hash actual source against immutable pre-workload metadata, never the index."""
import hashlib,os,stat
from pathlib import Path
from common import canonical,digest,git_command,read_regular
MAX_TRACKED_FILE=50*1024*1024
MAX_TRACKED_TOTAL=512*1024*1024
MAX_TRACKED_PATHS=30000


def check_tracked(value):
 if not isinstance(value,dict) or not 0<len(value)<=MAX_TRACKED_PATHS:raise ValueError('Invalid tracked metadata count')
 total=0
 for name,entry in value.items():
  # Kept independent of manifest.py to avoid a circular image import.
  if not isinstance(name,str) or len(name)>4096 or name.startswith('/') or '\\' in name or any(ord(c)<32 or ord(c)==127 for c in name) or any(p in ('','..','.','.git') for p in name.split('/')) or len(name.split('/'))>64:raise ValueError('Invalid tracked path')
  if not isinstance(entry,list) or len(entry)!=3 or entry[0] not in ('100644','100755','120000') or not isinstance(entry[1],str) or len(entry[1])!=40 or any(c not in '0123456789abcdef' for c in entry[1]) or type(entry[2]) is not int or not 0<=entry[2]<=MAX_TRACKED_FILE:raise ValueError('Invalid tracked blob metadata')
  total+=entry[2]
  if total>MAX_TRACKED_TOTAL:raise ValueError('Tracked byte total exceeds bound')
 return total


def entry_bytes(root_fd,name,expected,remaining):
 limit=min(MAX_TRACKED_FILE,remaining)
 descriptors=[];directory=root_fd
 try:
  parts=name.split('/')
  for part in parts[:-1]:
   directory=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory);descriptors.append(directory)
  info=os.stat(parts[-1],dir_fd=directory,follow_symlinks=False)
  if expected[0]=='120000':
   if not stat.S_ISLNK(info.st_mode):raise ValueError('Tracked link type differs')
   data=os.fsencode(os.readlink(parts[-1],dir_fd=directory))
   if len(data)>limit:raise ValueError('Tracked link exceeds bound')
   after=os.stat(parts[-1],dir_fd=directory,follow_symlinks=False)
   if (info.st_ino,info.st_ctime_ns)!=(after.st_ino,after.st_ctime_ns):raise ValueError('Tracked link changed during guard')
   return ['120000',hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest(),len(data)]
  fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
  with os.fdopen(fd,'rb') as stream:
   initial=os.fstat(stream.fileno())
   if not stat.S_ISREG(initial.st_mode) or not 0<=initial.st_size<=limit:raise ValueError('Tracked file type/size differs')
   executable=initial.st_mode&0o111
   if executable not in (0,0o111):raise ValueError('Tracked executable bits differ')
   mode='100755' if executable else '100644'
   hasher=hashlib.sha1(b'blob '+str(initial.st_size).encode()+b'\0');size=0
   while True:
    chunk=stream.read(min(65536,limit-size+1))
    if not chunk:break
    size+=len(chunk)
    if size>limit:raise ValueError('Tracked file grew beyond bound')
    hasher.update(chunk)
   after=os.fstat(stream.fileno())
   if size!=initial.st_size or (initial.st_ino,initial.st_size,initial.st_mtime_ns,initial.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('Tracked file changed during guard')
   return [mode,hasher.hexdigest(),size]
 finally:
  for fd in reversed(descriptors):os.close(fd)


def actual_inventory(root,tracked):
 check_tracked(tracked);actual={};total=0
 fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  for name,expected in tracked.items():
   observed=entry_bytes(fd,name,expected,MAX_TRACKED_TOTAL-total);total+=observed[2]
   if total>MAX_TRACKED_TOTAL:raise ValueError('Actual tracked bytes exceed bound')
   actual[name]=observed
 finally:os.close(fd)
 return dict(actualTrackedInventorySha256=digest(canonical(actual)),trackedFilesChecked=len(actual),trackedBytesChecked=total)


def git_policy(root,tracked):
 # The mutable index is never source authority: every entry must still match the
 # immutable manifest, and every flag must be ordinary (no assume/skip bits).
 raw=git_command(root,['ls-files','--stage','-z'],output_limit=8*1024*1024);index={}
 if raw and not raw.endswith('\0'):raise ValueError('Truncated tracked index')
 for row in raw.split('\0')[:-1]:
  metadata,name=row.split('\t',1);mode,blob,stage=metadata.split()
  if stage!='0' or name in index:raise ValueError('Invalid tracked index stage')
  index[name]=[mode,blob]
 if index!={n:e[:2] for n,e in tracked.items()}:raise ValueError('Tracked index differs from immutable metadata')
 flags=git_command(root,['ls-files','-v','-z'],output_limit=8*1024*1024)
 if set(flags.split('\0')[:-1])!={'H '+name for name in tracked} or not flags.endswith('\0'):raise ValueError('Tracked index flags differ')
 config=git_command(root,['config','--null','--list'])
 for item in config.split('\0'):
  if not item:continue
  key,_,value=item.partition('\n');key=key.lower()
  if key in ('core.excludesfile','core.worktree','core.fsmonitor','core.untrackedcache','core.sparsecheckout','core.sparsecheckoutcone','extensions.worktreeconfig') or (key=='core.ignorecase' and value.lower()!='false'):raise ValueError('Git source ignore/config override')
 # Ancestors are checked without following candidate-swapped .git/info links.
 fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);descriptors=[fd]
 try:
  for part in ('.git','info'):
   fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);descriptors.append(fd)
  try:file=os.open('exclude',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  except FileNotFoundError:data=b''
  else:
   with os.fdopen(file,'rb') as stream:
    info=os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_size>65536:raise ValueError('Invalid Git local excludes')
    data=stream.read(65537)
  if len(data)>65536 or any(line.strip() and not line.lstrip().startswith(b'#') for line in data.splitlines()):raise ValueError('Git local source exclusion')
 finally:
  for fd in reversed(descriptors):os.close(fd)
 return dict(indexMatches=True,indexFlagsClean=True,ignorePolicyClean=True)
