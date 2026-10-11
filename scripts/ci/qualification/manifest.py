"""Root-controlled public metadata inventory. Never execute candidate source."""
import base64,hashlib,json,re,urllib.request,os,sys,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from pathlib import PurePosixPath
from common import canonical,digest,read_regular,decode_json,git_command
from contract import REPOSITORY,CONFIGS,ELECTRON
MAX_TREE=30000
MAX_MANIFEST=1024*1024
OPS=('scripts/ops/launch-funded-config-repair.py','scripts/ops/repair-funded-chat-config.py')

def sha(value):
 if not isinstance(value,str) or not re.fullmatch('[a-f0-9]{40}',value):raise ValueError('Invalid source SHA')
 return value

def path(value):
 if not isinstance(value,str) or len(value)>4096 or any(ord(c)<32 or ord(c)==127 for c in value) or value.startswith('/') or '\\' in value or any(p in ('','..','.') for p in value.split('/')):raise ValueError('Invalid tracked path')
 return value

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise ValueError('Public API redirect rejected')

def public_api(endpoint,limit):
 if not re.fullmatch(r'(commits/[a-f0-9]{40}|git/(trees/[a-f0-9]{40}\?recursive=1|blobs/[a-f0-9]{40}))',endpoint):raise ValueError('Invalid public API endpoint')
 request=urllib.request.Request('https://api.github.com/repos/'+REPOSITORY+'/'+endpoint,headers={'Accept':'application/vnd.github+json','User-Agent':'matrix-ci-qualification'})
 with urllib.request.build_opener(NoRedirect()).open(request,timeout=10) as response:
  data=response.read(limit+1)
  if len(data)>limit:raise ValueError('Public API response exceeds bound')
  return decode_json(data)

def git_blob(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()

def blob(api,entry,cap):
 if entry['type']!='blob' or entry['mode'] not in ('100644','100755') or type(entry.get('size')) is not int or not 0<entry['size']<=cap:raise ValueError('Required source blob mode/size differs')
 value=api('git/blobs/'+sha(entry['sha']),cap*2+65536)
 if not isinstance(value,dict) or value.get('sha')!=entry['sha'] or value.get('encoding')!='base64' or value.get('size')!=entry['size']:raise ValueError('Public blob metadata differs')
 try:data=base64.b64decode(value['content'],validate=False)
 except (KeyError,ValueError,TypeError) as error:raise ValueError('Invalid public blob') from error
 if len(data)!=entry['size'] or git_blob(data)!=entry['sha']:raise ValueError('Public blob digest differs')
 return data

def strip_comments(source):
 result=[];index=0;quote=None
 while index<len(source):
  char=source[index]
  if quote:
   result.append(char);index+=1
   if char=='\\' and index<len(source):result.append(source[index]);index+=1
   elif char==quote:quote=None
  elif char in ('"',"'",'`'):quote=char;result.append(char);index+=1
  elif source.startswith('//',index):
   end=source.find('\n',index+2);index=len(source) if end<0 else end
  elif source.startswith('/*',index):
   end=source.find('*/',index+2)
   if end<0:raise ValueError('Unclosed source comment')
   result.append(' ');index=end+2
  else:result.append(char);index+=1
 if quote:raise ValueError('Unclosed source literal')
 return ''.join(result)

def collection_scope(source,include,exclude=None):
 # Inventory remains all tracked tests in the reviewed glob, irrespective of
 # candidate code. Only literal known config scopes are supported; fail closed
 # on any change rather than silently execute root-side JavaScript.
 source=strip_comments(source)
 found=re.findall(r'\binclude\s*:\s*\[([^\]]*)\]',source)
 if not found:raise ValueError('Missing literal collection scope')
 def literal(raw):
  values=re.findall(r'"([^"\\]*)"|\x27([^\x27\\]*)\x27',raw)
  residue=re.sub(r'"[^"\\]*"|\x27[^\x27\\]*\x27|[\s,]','',raw)
  if residue:raise ValueError('Dynamic collection scope')
  return [a or b for a,b in values]
 if literal(found[0])!=include:raise ValueError('Collection include scope changed')
 if exclude is not None:
  found=re.findall(r'\bexclude\s*:\s*\[([^\]]*)\]',source)
  if not found or literal(found[0])!=exclude:raise ValueError('Collection exclude scope changed')
 else:
  if re.search(r'\bexclude\s*:',source):raise ValueError('Unexpected E2E exclusion')

def icon_names(source):
 blocks=re.findall(r'import\s*\{([^}]+)\}\s*from\s*["\x27]@hugeicons/core-free-icons["\x27]',source)
 names=sorted(set(entry.strip().split(' as ')[0] for block in blocks for entry in block.split(',') if entry.strip()))
 if not 1<len(names)<=2000 or any(not re.fullmatch(r'[A-Za-z_$][A-Za-z0-9_$]*',name) for name in names):raise ValueError('Invalid icon inventory')
 return names

def prepare_manifest(source,request,api=None):
 sha(source);api=api or public_api
 if not isinstance(request,dict) or request.get('repository')!=REPOSITORY or request.get('mergeSha')!=source:raise ValueError('Wrong qualification request')
 parents=request.get('mergeParents')
 if not isinstance(parents,list) or len(parents)!=2 or parents!=[request.get('baseSha'),request.get('headSha')]:raise ValueError('Wrong ordered merge parents')
 for parent in parents:sha(parent)
 commit=api('commits/'+source,1024*1024)
 if not isinstance(commit,dict) or commit.get('sha')!=source or [p.get('sha') for p in commit.get('parents',[])]!=parents:raise ValueError('Public merge commit differs')
 tree_sha=sha(commit['commit']['tree']['sha']);tree=api('git/trees/'+tree_sha+'?recursive=1',8*1024*1024)
 if tree.get('sha')!=tree_sha or tree.get('truncated') is not False or not isinstance(tree.get('tree'),list) or not 0<len(tree['tree'])<=MAX_TREE:raise ValueError('Incomplete public tree')
 entries={}
 for item in tree['tree']:
  name=path(item.get('path'))
  if name in entries:raise ValueError('Duplicate public tree path')
  sha(item.get('sha'));entries[name]=item
 def content(name,cap=256*1024):
  if name not in entries:raise ValueError('Missing required tracked source')
  return blob(api,entries[name],cap)
 configs={name:content(name) for name in CONFIGS}
 collection_scope(configs['vitest.config.ts'].decode(),['tests/**/*.test.ts','tests/**/*.test.tsx'],['tests/**/*.integration.ts','tests/e2e/**','node_modules','dist','.next'])
 collection_scope(configs['vitest.e2e.config.ts'].decode(),['tests/e2e/**/*.e2e.test.ts'])
 for name,entry in entries.items():
  if name.startswith('tests/') and name.endswith(('.test.ts','.test.tsx')) and (entry['type']!='blob' or entry['mode'] not in ('100644','100755')):raise ValueError('Unsupported tracked test mode')
 files=[n for n,e in entries.items() if e['type']=='blob' and e['mode'] in ('100644','100755')]
 unit=sorted(n for n in files if n.startswith('tests/') and not n.startswith('tests/e2e/') and n.endswith(('.test.ts','.test.tsx')))
 general=sorted(n for n in files if n.startswith('tests/e2e/') and n.endswith('.e2e.test.ts'))
 if not 0<len(unit)<=10000 or not 0<len(general)<=10000:raise ValueError('Invalid test inventory')
 for names in ELECTRON.values():
  for name in names:
   if name not in general or name not in configs['.github/workflows/ci.yml'].decode():raise ValueError('Required Electron workflow scope changed')
 imports={n.rsplit('/',1)[1]:{'sha256':digest(content(n)),'mode':int(entries[n]['mode'][-3:],8)} for n in OPS}
 icons=icon_names(content('shell/src/lib/hugeicons.tsx').decode())
 packages={n:decode_json(content(n)) for n in ('package.json','shell/package.json')}
 lock=content('pnpm-lock.yaml',2*1024*1024)
 native=packages['package.json']['devDependencies'].get('@typescript/native','')
 if not re.fullmatch(r'npm:typescript@[0-9]+\.[0-9]+\.[0-9]+',native):raise ValueError('Native compiler pin changed')
 versions=set(re.findall(r"^  '@hugeicons/core-free-icons@([0-9]+\.[0-9]+\.[0-9]+)':$",lock.decode(),flags=re.M))
 if len(versions)!=1:raise ValueError('Ambiguous frozen icon version')
 tools={'pnpm':packages['package.json'].get('packageManager','').removeprefix('pnpm@'),'nativeTypeScript':native.rsplit('@',1)[1],'next':packages['shell/package.json']['dependencies']['next'],'icons':next(iter(versions))}
 if any(not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',v) for v in tools.values()):raise ValueError('Unpinned runtime dependency')
 result={'schemaVersion':1,'repository':REPOSITORY,'source':source,'tree':tree_sha,'parents':parents,'lockSha256':digest(lock),'configBlobs':{n:entries[n]['sha'] for n in CONFIGS},'configSha256':{n:digest(v) for n,v in configs.items()},'unit':unit,'general':general,'requiredElectron':ELECTRON,'icons':icons,'unitImports':imports,'tools':tools}
 if len(canonical(result))>MAX_MANIFEST:raise ValueError('Manifest exceeds bound')
 return check_manifest(result,request)

def check_manifest(value,request=None):
 if not isinstance(value,dict) or value.get('schemaVersion')!=1 or value.get('repository')!=REPOSITORY:raise ValueError('Invalid manifest')
 sha(value.get('source'));sha(value.get('tree'))
 if not isinstance(value.get('parents'),list) or len(value['parents'])!=2:raise ValueError('Manifest parents differ')
 for parent in value['parents']:sha(parent)
 for key in ('unit','general'):
  names=value.get(key)
  if not isinstance(names,list) or not 0<len(names)<=10000 or names!=sorted(set(names)):raise ValueError('Invalid source inventory')
  for name in names:
   path(name)
   if not name.startswith('tests/') or (key=='unit' and (name.startswith('tests/e2e/') or not name.endswith(('.test.ts','.test.tsx')))) or (key=='general' and (not name.startswith('tests/e2e/') or not name.endswith('.e2e.test.ts'))):raise ValueError('Inventory scope differs')
 if value.get('requiredElectron')!=ELECTRON or any(n not in value['general'] for names in ELECTRON.values() for n in names):raise ValueError('Required Electron inventory differs')
 if not re.fullmatch('[a-f0-9]{64}',value.get('lockSha256','')) or set(value.get('configBlobs',{}))!=set(CONFIGS) or set(value.get('configSha256',{}))!=set(CONFIGS):raise ValueError('Manifest source digest differs')
 for name in CONFIGS:
  sha(value['configBlobs'][name])
  if not re.fullmatch('[a-f0-9]{64}',value['configSha256'][name]):raise ValueError('Config digest differs')
 icons=value.get('icons');imports=value.get('unitImports')
 if not isinstance(icons,list) or not 1<len(icons)<=2000 or icons!=sorted(set(icons)) or any(not re.fullmatch('[A-Za-z_$][A-Za-z0-9_$]*',x) for x in icons):raise ValueError('Icon inventory differs')
 if not isinstance(imports,dict) or set(imports)!={n.rsplit('/',1)[1] for n in OPS}:raise ValueError('Readonly import inventory differs')
 for name,entry in imports.items():
  if not isinstance(entry,dict) or entry.get('mode')!=0o644 or not re.fullmatch('[a-f0-9]{64}',entry.get('sha256','')):raise ValueError('Readonly source digest/mode differs')
 tools=value.get('tools')
 if not isinstance(tools,dict) or set(tools)!={'pnpm','nativeTypeScript','next','icons'} or any(not isinstance(x,str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',x) for x in tools.values()):raise ValueError('Pinned tool manifest differs')
 if request is not None and (request.get('repository')!=REPOSITORY or request.get('mergeSha')!=value['source'] or request.get('mergeParents')!=value['parents'] or [request.get('baseSha'),request.get('headSha')]!=value['parents']):raise ValueError('Request/source manifest differs')
 if len(canonical(value))>MAX_MANIFEST:raise ValueError('Manifest exceeds bound')
 return value

def load_manifest(filename,expected_sha):
 if not re.fullmatch('[a-f0-9]{64}',expected_sha):raise ValueError('Invalid manifest digest')
 data=read_regular(filename,MAX_MANIFEST)
 if digest(data)!=expected_sha:raise ValueError('Manifest bytes differ')
 return check_manifest(decode_json(data))


def manifest_bytes(value):
 data=canonical(check_manifest(value))+b'\n'
 if len(data)>MAX_MANIFEST:raise ValueError('Manifest transport exceeds bound')
 return data


def prepare_manifest_from_git(source,request,root,run=None):
 """Derive the API-shaped metadata using only Git plumbing; no checkout code."""
 sha(source)
 if request.get('repository')!=REPOSITORY or request.get('mergeSha')!=source:raise ValueError('Wrong preparation request')
 run=run or (lambda args,cap:git_command(root,args,output_limit=cap))
 metadata=run(['show','-s','--format=%H%n%T%n%P',source],1024*1024).strip().splitlines()
 if len(metadata)!=3 or metadata[0]!=source:raise ValueError('Git commit metadata differs')
 tree=sha(metadata[1]);parents=metadata[2].split(' ')
 if parents!=request.get('mergeParents') or parents!=[request.get('baseSha'),request.get('headSha')]:raise ValueError('Git ordered parents differ')
 raw=run(['ls-tree','-r','-l','-z',source],8*1024*1024)
 if not raw.endswith('\0'):raise ValueError('Truncated Git tree output')
 rows=raw.split('\0')[:-1]
 if not 0<len(rows)<=MAX_TREE:raise ValueError('Git tree count differs')
 entries=[];seen=set();objects={}
 for row in rows:
  match=re.fullmatch(r'([0-9]{6}) (blob|commit) ([a-f0-9]{40}) +([0-9]+|-)\t(.+)',row)
  if not match:raise ValueError('Invalid Git tree entry')
  mode,kind,blob_sha,size,name=match.groups();path(name)
  if name in seen:raise ValueError('Duplicate Git tree path')
  seen.add(name);entries.append(dict(path=name,type=kind,mode=mode,sha=blob_sha,size=int(size) if size!='-' else None))
 def api(endpoint,cap):
  if endpoint=='commits/'+source:return dict(sha=source,parents=[dict(sha=p) for p in parents],commit=dict(tree=dict(sha=tree)))
  if endpoint=='git/trees/'+tree+'?recursive=1':return dict(sha=tree,truncated=False,tree=entries)
  if not endpoint.startswith('git/blobs/'):raise ValueError('Unexpected Git metadata request')
  object_sha=sha(endpoint.removeprefix('git/blobs/'))
  entry=next((e for e in entries if e['sha']==object_sha and e['type']=='blob'),None)
  if entry is None or type(entry['size']) is not int or not 0<entry['size']<=2*1024*1024:raise ValueError('Git blob size differs')
  if object_sha not in objects:
   data=run(['cat-file','blob',object_sha],min(8*1024*1024,entry['size']+65536)).encode()
   if len(data)!=entry['size'] or git_blob(data)!=object_sha:raise ValueError('Git blob content differs')
   objects[object_sha]=dict(sha=object_sha,encoding='base64',size=len(data),content=base64.b64encode(data).decode())
  return objects[object_sha]
 return prepare_manifest(source,request,api)


def prepare_public(source,base,head,root=Path('/work/manifest-source')):
 for value in (source,base,head):sha(value)
 if os.getuid()!=10001:raise ValueError('Source preparation requires isolated UID')
 started=time.monotonic();root.mkdir(mode=0o700,parents=False,exist_ok=False)
 def run(args,cap=1024*1024):
  remaining=120-(time.monotonic()-started)
  if remaining<=0:raise ValueError('Source preparation deadline')
  return git_command(root,args,output_limit=cap,deadline_seconds=remaining)
 run(['init','--quiet']);run(['remote','add','origin','https://github.com/'+REPOSITORY+'.git']);run(['fetch','--depth=2','origin',source+':refs/ci/source'])
 request=dict(repository=REPOSITORY,mergeSha=source,baseSha=base,headSha=head,mergeParents=[base,head])
 return prepare_manifest_from_git(source,request,root,run)


if __name__=='__main__':
 try:
  if len(sys.argv)!=5 or sys.argv[1]!='--prepare-public':raise ValueError('Invalid manifest invocation')
  sys.stdout.buffer.write(manifest_bytes(prepare_public(*sys.argv[2:])))
 except (ValueError,RuntimeError,OSError,ExceptionGroup,KeyError,TypeError):
  print('Trusted public source preparation failed',file=sys.stderr);sys.exit(1)
