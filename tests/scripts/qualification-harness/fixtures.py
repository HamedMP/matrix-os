import base64,copy,hashlib,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts/ci/qualification'))
from contract import ELECTRON,CONFIGS,ARTIFACTS,PHASES,PROVENANCE,HOST_PROVENANCE,LANES
import manifest
from common import canonical,digest

SOURCE='1'*40;TREE='2'*40;PARENTS=['3'*40,'4'*40]
def request():return dict(repository=manifest.REPOSITORY,mergeSha=SOURCE,mergeParents=PARENTS.copy(),baseSha=PARENTS[0],headSha=PARENTS[1],imageDigest='sha256:'+'5'*64,harnessDigest='6'*64)
def api_fixture():
 files={'vitest.config.ts':'test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], exclude: ["tests/**/*.integration.ts", "tests/e2e/**", "node_modules", "dist", ".next"]}', 'vitest.e2e.config.ts':'test: { include: ["tests/e2e/**/*.e2e.test.ts"] }','.github/workflows/ci.yml':'\n'.join(p for names in ELECTRON.values() for p in names),'package.json':json.dumps({'packageManager':'pnpm@10.33.4','devDependencies':{'@typescript/native':'npm:typescript@7.0.2'}}),'shell/package.json':json.dumps({'dependencies':{'next':'16.2.6','@hugeicons/core-free-icons':'^4.3.0'}}),'pnpm-lock.yaml':"packages:\n  '@hugeicons/core-free-icons@4.3.0':\n    resolution: fixed\n",'shell/src/lib/hugeicons.tsx':'import { AlphaIcon, BetaIcon } from "@hugeicons/core-free-icons";','tests/a.test.ts':'case','tests/a.test.tsx':'case','tests/ignored.integration.ts':'not unit'}
 for name in manifest.OPS:files[name]='def require(ok, code):\n if not ok: raise ValueError(code)\n'
 for names in ELECTRON.values():
  for name in names:files[name]='test case'
 objects={};entries=[]
 for name,source in files.items():
  data=source.encode();blob=manifest.git_blob(data);entries.append({'path':name,'type':'blob','mode':'100644','sha':blob,'size':len(data)});objects[blob]={'sha':blob,'encoding':'base64','size':len(data),'content':base64.b64encode(data).decode()}
 commit={'sha':SOURCE,'parents':[{'sha':p} for p in PARENTS],'commit':{'tree':{'sha':TREE}}};tree={'sha':TREE,'truncated':False,'tree':entries}
 def api(endpoint,cap):
  return copy.deepcopy(commit if endpoint=='commits/'+SOURCE else tree if endpoint=='git/trees/'+TREE+'?recursive=1' else objects[endpoint.removeprefix('git/blobs/')])
 return api,commit,tree,objects

def inventory():return manifest.prepare_manifest(SOURCE,request(),api_fixture()[0])
def report(paths,phase):
 root='/work/unit/' if phase=='unit' else '/work/e2e/'
 return dict(success=True,numFailedTests=0,numFailedTestSuites=0,numTotalTests=len(paths),numPassedTests=len(paths),numPendingTests=0,testResults=[dict(name=root+p,status='passed',assertionResults=[dict(status='passed',title='case',fullName='case',ancestorTitles=[],failureMessages=[])]) for p in paths])
def evidence(directory):
 inv=inventory();req=request();ms=digest(canonical(inv)+b'\n');empty=digest(b'[]')
 for name in ARTIFACTS:(directory/name).write_text('')
 for name in ('exit-code','benchmark-exit-code','smoke-exit-code'):(directory/name).write_text('0')
 for name,value in [('source-sha',SOURCE),('image-id',req['imageDigest']),('inventory-sha256',ms)]:(directory/name).write_text(value)
 metadata=dict(source=SOURCE,image=req['imageDigest'],harnessDigest=req['harnessDigest'],tree=TREE,parents=PARENTS,lockSha256=inv['lockSha256'],inventorySha256=ms,status=0,checkoutRoots={l:'/work/'+l for l in LANES},installCount=4,unitWorkers=16,generalWorkers=2,gridWorkers=1,clipboardWorkers=1,wallSeconds=10,queueSeconds=0,queueStartedUtc='2026-10-11T00:00:00Z',startedUtc='2026-10-11T00:00:00Z',finishedUtc='2026-10-11T00:00:10Z')
 (directory/'qualification.json').write_text(json.dumps(metadata));(directory/'tools.json').write_text(json.dumps(dict(node='v24.13.1',pnpm=inv['tools']['pnpm'],nativeTypeScript=inv['tools']['nativeTypeScript'],bun='1.3.13')))
 for name in (*PROVENANCE,*HOST_PROVENANCE):
  lane,stage=(name.removeprefix('host-source-').removesuffix('.json'),'host-final') if name in HOST_PROVENANCE else name.removeprefix('source-').removesuffix('.json').split('-',1)
  integrity=dict(inventorySha256=ms,trackedInventorySha256=inv['trackedInventorySha256'],actualTrackedInventorySha256=inv['trackedInventorySha256'],trackedFilesChecked=len(inv['tracked']),trackedBytesChecked=sum(e[2] for e in inv['tracked'].values()),trackedIntegrityClean=True,indexMatches=True,indexFlagsClean=True,ignorePolicyClean=True)
  (directory/name).write_text(json.dumps(dict(**integrity,source=SOURCE,actualSource=SOURCE,lane=lane,stage=stage,clean=True,lockSha256=inv['lockSha256'],lockMatches=True,tracked=[],untracked=[],trackedPathsSha256=empty,untrackedPathsSha256=empty)))
 for lane,phases in PHASES.items():(directory/('timing-'+lane+'.tsv')).write_text(''.join(p+'\t1\t0\n' for p in phases))
 for phase in ('unit','general',*ELECTRON):(directory/(phase+'.json')).write_text(json.dumps(report(inv[phase] if phase in ('unit','general') else ELECTRON[phase],phase)))
 (directory/'coverage.json').write_text(json.dumps(dict(source=SOURCE,tree=TREE,inventorySha256=ms,files=len(inv['unit']),total=len(inv['unit']),passed=len(inv['unit']),skipped=0,failed=0)))
 trace=dict(optimizerRequests=1,uniqueIconLeaves=1,buildSpans=2)
 (directory/'smoke.json').write_text(json.dumps(dict(nextVersion=inv['tools']['next'],iconsVersion=inv['tools']['icons'],comparedExports=len(inv['icons']),svgRenderComparisons=len(inv['icons']),distinctIconModules=2,negativeAliasControl='rejected',missingExportControl='rejected',trace=trace)))
 (directory/'trace').write_text(json.dumps([dict(name='build-module',tags=dict(name='/node_modules/@hugeicons/core-free-icons/__barrel_optimize__')),dict(name='build-module',tags=dict(name='/node_modules/@hugeicons/core-free-icons/AlphaIcon.js'))]))
 return inv,req


def tracked_fixture(root,commit='HEAD'):
 import subprocess
 tracked={}
 for row in subprocess.check_output(['git','-C',str(root),'ls-tree','-rlz',commit]).decode().split('\0')[:-1]:
  metadata,name=row.split('\t');mode,kind,sha,size=metadata.split();tracked[name]=[mode,sha,int(size)]
 return tracked
