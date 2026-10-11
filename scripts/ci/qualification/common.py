"""Bounded immutable-image I/O and child process operations."""
import hashlib,json,os,stat,subprocess,selectors,signal,time,sys
GIT_DEADLINE_SECONDS=120
MAX_GIT_OUTPUT=1024*1024

def read_regular(path,cap):
 with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as file:
  info=os.fstat(file.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_size>cap:raise ValueError('Invalid regular bounded input')
  data=file.read(cap+1)
  if len(data)>cap:raise ValueError('Input grew beyond bound')
  return data

def git_command(root,args,*,output_limit=None,deadline_seconds=None):
 limit=MAX_GIT_OUTPUT if output_limit is None else output_limit
 seconds=GIT_DEADLINE_SECONDS if deadline_seconds is None else deadline_seconds
 if type(limit) is not int or not 0<limit<=8*1024*1024 or not isinstance(seconds,(int,float)) or not 0<=seconds<=120:raise ValueError("Invalid Git operation bounds")
 # Log bounds apply to pipes only: Git's object packs and checkout files may
 # legitimately exceed1MiB inside the container's unchanged64GiB tmpfs cap.
 stage=args[0] if args and args[0] in ('fetch','bundle','checkout','rev-parse','show','init','remote','hash-object') else 'other'
 step=stage
 def error(category,status):return RuntimeError('Git source preparation: stage='+stage+' step='+step+' category='+category+' status='+str(status))
 try:
  process=subprocess.Popen(['git',*args],cwd=root,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env=dict(os.environ,GIT_TERMINAL_PROMPT='0'))
 except OSError:
  raise error('command_unavailable','unavailable') from None
 deadline=time.monotonic()+seconds
 output=[bytearray(),bytearray()];total=0;failure=None;cleanup=[]
 try:
  with selectors.DefaultSelector() as selector:
   selector.register(process.stdout,selectors.EVENT_READ,0);selector.register(process.stderr,selectors.EVENT_READ,1)
   while selector.get_map():
    left=deadline-time.monotonic()
    if left<=0:raise error('deadline','timeout')
    for key,_ in selector.select(min(left,0.25)):
     chunk=os.read(key.fileobj.fileno(),min(65536,limit-total+1))
     if not chunk:selector.unregister(key.fileobj);continue
     total+=len(chunk)
     if total>limit:raise error('output_bound','rejected')
     output[key.data].extend(chunk)
  try:process.wait(timeout=max(0.001,deadline-time.monotonic()))
  except subprocess.TimeoutExpired:raise error('deadline','timeout') from None
 except BaseException as caught:
  failure=caught
 finally:
  if process.poll() is None:
   try:os.killpg(process.pid,signal.SIGKILL)
   except ProcessLookupError:print('Git source group exited before bounded cleanup',file=sys.stderr)
   except OSError:cleanup.append(error('cleanup_signal','failed'))
  try:process.wait(timeout=5)
  except subprocess.TimeoutExpired:cleanup.append(error('cleanup_reap','timeout'))
  process.stdout.close();process.stderr.close()
 if cleanup:raise BaseExceptionGroup('Git source preparation and cleanup failed',([failure] if failure else [])+cleanup)
 if failure:raise failure from None
 if process.returncode:
  text=output[1].decode('utf8',errors='replace').lower()
  missing=('not our ref','unadvertised object',"couldn't find remote ref",'did not contain','does not appear to be a git repository')
  network=('could not resolve host','failed to connect','connection timed out','network is unreachable','connection reset','tls connection')
  category='source_unavailable' if any(word in text for word in missing) else 'network' if any(word in text for word in network) else 'command_failed'
  raise error(category,process.returncode)
 return output[0].decode('utf8')


def canonical(value):
 return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()

def write_json(path,value):
 with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as output:output.write(canonical(value)+b'\n')

def digest(data):return hashlib.sha256(data).hexdigest()

def decode_json(data):
 def unique(pairs):
  result={}
  for key,value in pairs:
   if key in result:raise ValueError('Duplicate JSON field')
   result[key]=value
  return result
 return json.loads(data,object_pairs_hook=unique)
