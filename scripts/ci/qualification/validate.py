"""Independent root-side evidence validator using the trusted public manifest."""
import collections,datetime,hashlib,json,os,re,stat,sys
from pathlib import Path,PurePosixPath
sys.path.insert(0,str(Path(__file__).resolve().parent))
from common import canonical,digest,read_regular,decode_json
from manifest import check_manifest
from contract import ARTIFACTS,PHASES as LANE_PHASES,PROVENANCE,REPORTS,LANES,MAX_FILE,MAX_TOTAL

def read(path,limit=50*1024*1024):
 with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
  info=os.fstat(f.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_size>limit: raise ValueError('Nonregular or oversized evidence')
  value=f.read(limit+1)
  if len(value)>limit: raise ValueError('Evidence grew beyond bound')
  return value


def report_counts(report,phase,inventory,diagnostic=False):
 REPORT_FILES=inventory['requiredElectron']
 if phase not in REPORTS or not isinstance(report,dict) or type(report.get('success')) is not bool:raise ValueError('Invalid report')
 if not diagnostic and (report['success'] is not True or report.get('numFailedTests')!=0 or report.get('numFailedTestSuites',0)!=0):raise ValueError('Report did not pass')
 statuses=('passed','skipped','failed') if diagnostic else ('passed','skipped')
 files=report.get('testResults');paths=set();counts=collections.Counter()
 if not isinstance(files,list) or not 0<len(files)<=10000: raise ValueError('Invalid file count')
 root='/work/unit/' if phase=='unit' else '/work/e2e/'
 for file in files:
  if not isinstance(file,dict) or file.get('status') not in statuses: raise ValueError('Invalid file result')
  name=file.get('name')
  if not isinstance(name,str) or len(name)>4096 or not name.startswith(root+'tests/'): raise ValueError('Wrong report lane/root')
  relative=name.removeprefix(root)
  if '..' in PurePosixPath(relative).parts or '\\' in relative or relative in paths: raise ValueError('Invalid or duplicate report path')
  if phase=='unit':
   if relative.startswith('tests/e2e/') or not relative.endswith(('.test.ts','.test.tsx')): raise ValueError('Unexpected unit file')
  elif not relative.startswith('tests/e2e/') or not relative.endswith('.e2e.test.ts'): raise ValueError('Unexpected E2E file')
  paths.add(relative);assertions=file.get('assertionResults')
  if not isinstance(assertions,list) or len(assertions)>100000: raise ValueError('Invalid assertions')
  passed=0
  for assertion in assertions:
   if not isinstance(assertion,dict) or assertion.get('status') not in statuses or (not diagnostic and assertion.get('failureMessages')): raise ValueError('Failed assertion')
   if file['status']=='skipped' and assertion['status']!='skipped': raise ValueError('Skipped file contains active assertion')
   if any(not isinstance(assertion.get(k),str) or len(assertion[k])>256*1024 for k in ('title','fullName')): raise ValueError('Invalid assertion identity')
   ancestry=assertion.get('ancestorTitles')
   if not isinstance(ancestry,list) or len(ancestry)>100 or any(not isinstance(t,str) or len(t)>16384 for t in ancestry): raise ValueError('Invalid assertion ancestry')
   messages=assertion.get('failureMessages',[])
   if not isinstance(messages,list) or len(messages)>100 or any(not isinstance(m,str) or len(m)>1024*1024 for m in messages):raise ValueError('Invalid failure evidence')
   counts[assertion['status']]+=1
   if assertion['status']=='passed':passed+=1
   if sum(counts.values())>100000: raise ValueError('Case count cap exceeded')
  if not diagnostic and phase in REPORT_FILES and passed==0:raise ValueError('Required file has no passed assertion')
 if phase in REPORT_FILES and paths!=set(REPORT_FILES[phase]): raise ValueError('Required E2E report file identity differs')
 if report.get('numTotalTests')!=sum(counts.values()) or report.get('numPassedTests')!=counts['passed'] or report.get('numPendingTests')!=counts['skipped'] or report.get('numFailedTests')!=counts['failed']: raise ValueError('Counts differ from assertions')
 expected=REPORT_FILES.get(phase) or inventory[phase]
 if not diagnostic and paths!=set(expected):raise ValueError('Frozen source file inventory differs')
 return dict(files=len(paths),total=sum(counts.values()),passed=counts['passed'],skipped=counts['skipped'],failed=counts['failed'],inventoryComplete=paths==set(expected),expectedFiles=len(expected),missingFiles=len(set(expected)-paths),extraFiles=len(paths-set(expected)))


def phase_times(directory,include_smoke=True):
 result={}
 for lane,phases in LANE_PHASES.items():
  if lane=='smoke' and not include_smoke:continue
  seen={}
  for line in read(directory/f'timing-{lane}.tsv',65536).decode().splitlines():
   fields=line.split('\t')
   if len(fields)!=3 or fields[0] not in phases or fields[0] in seen or not fields[1].isdigit() or not 0<=int(fields[1])<=1800 or fields[2]!='0': raise ValueError('Invalid or failed promised phase')
   seen[fields[0]]=int(fields[1])
  if set(seen)!=set(phases): raise ValueError('Missing promised phase')
  result.update(seen)
 return result


def web_phase_ready(directory,inventory):
 lines=read(Path(directory)/'timing-web.tsv',65536).decode().splitlines()
 if len(lines)!=2:raise ValueError('Web phase or provenance is absent or duplicated')
 if lines[1].split('\t')[::2]!=['source-after-web','0']:raise ValueError('Web provenance failed')
 validate_provenance(directory,inventory,tuple(name for name in PROVENANCE if name.startswith('source-web-')))
 fields=lines[0].split('\t')
 if len(fields)!=3 or fields[0]!='shell' or not fields[1].isdigit() or not 0<=int(fields[1])<=1800 or fields[2]!='0':raise ValueError('Web phase did not pass')
 return True


def validate_smoke(report,inventory):
 if not isinstance(report,dict):raise ValueError('Invalid icon smoke')
 expected=len(inventory['icons']);trace=report.get('trace')
 if report.get('nextVersion')!=inventory['tools']['next'] or report.get('iconsVersion')!=inventory['tools']['icons'] or report.get('comparedExports')!=expected or report.get('svgRenderComparisons')!=expected or report.get('negativeAliasControl')!='rejected' or report.get('missingExportControl')!='rejected':raise ValueError('Icon inventory/render/negative controls differ')
 distinct=report.get('distinctIconModules')
 if type(distinct) is not int or not 0<distinct<=expected or not isinstance(trace,dict):raise ValueError('Invalid icon module proof')
 for field in ('optimizerRequests','uniqueIconLeaves','buildSpans'):
  if type(trace.get(field)) is not int or not 0<=trace[field]<=100000:raise ValueError('Invalid production trace proof')
 if trace['optimizerRequests']<1 or trace['buildSpans']<1 or trace['uniqueIconLeaves']>distinct:raise ValueError('Production icon optimization absent')
 return report


def trace_summary(directory, smoke):
    paths, spans, row_count = set(), 0, 0
    # Read only bounded regular trace data; count exact events using the smoke's
    # installed-Next matcher, independently of its previously accepted JSON.
    for line in read(directory / 'trace').decode('utf8').splitlines():
        parsed = decode_json(line)
        rows = parsed if isinstance(parsed, list) else [parsed]
        row_count += len(rows)
        if row_count > 500000:
            raise ValueError('Trace event bound exceeded')
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError('Invalid production trace event')
            name, tags = row.get('name'), row.get('tags')
            if not isinstance(name, str) or not name.startswith('build-module') or not isinstance(tags, dict):
                continue
            path = tags.get('name')
            if not isinstance(path, str) or not ('@hugeicons+core-free-icons@' in path or '/@hugeicons/core-free-icons/' in path):
                continue
            if len(path) > 65536:
                raise ValueError('Icon trace path exceeds bound')
            spans += 1
            paths.add(path)
            if spans > 100000 or len(paths) > 10000:
                raise ValueError('Icon trace collection exceeds bounds')
    result = dict(optimizerRequests=sum('__barrel_optimize__' in p for p in paths),
                  uniqueIconLeaves=sum('__barrel_optimize__' not in p and not p.endswith('/index.js') for p in paths),
                  buildSpans=spans)
    if result != smoke.get('trace'):
        raise ValueError('Production trace does not match runtime smoke evidence')
    return result


def validate_provenance(directory,inventory,names=PROVENANCE):
 SOURCE,LOCK=inventory['source'],inventory['lockSha256']
 for name in names:
  value=decode_json(read(Path(directory)/name,256*1024))
  lane,stage=name.removeprefix('source-').removesuffix('.json').split('-',1)
  empty=hashlib.sha256(b'[]').hexdigest()
  if not isinstance(value,dict) or value.get('source')!=SOURCE or value.get('actualSource')!=SOURCE or value.get('lane')!=lane or value.get('stage')!=stage or value.get('clean') is not True or value.get('lockSha256')!=LOCK or value.get('lockMatches') is not True or value.get('tracked')!=[] or value.get('untracked')!=[] or value.get('trackedPathsSha256')!=empty or value.get('untrackedPathsSha256')!=empty or value.get('error') is not None:raise ValueError('Lane provenance failed')
 return True


def validate(directory,inventory,request):
 inventory=check_manifest(inventory,request)
 directory=Path(directory)
 if directory.is_symlink() or not directory.is_dir():raise ValueError('Invalid result directory')
 entries={entry.name for entry in directory.iterdir()}
 if entries!=set(ARTIFACTS):raise ValueError('Missing or unexpected result artifacts')
 total=0
 for name in ARTIFACTS:
  total+=len(read(directory/name,MAX_FILE))
  if total>MAX_TOTAL:raise ValueError('Aggregate evidence exceeds bound')
 for name in ('exit-code','benchmark-exit-code','smoke-exit-code'):
  if read(directory/name,128).decode().strip()!='0':raise ValueError('Qualification did not pass')
 inventory_sha=digest(canonical(inventory)+b'\n')
 if read(directory/'source-sha',128).decode().strip()!=inventory['source'] or read(directory/'image-id',128).decode().strip()!=request['imageDigest'] or read(directory/'inventory-sha256',128).decode().strip()!=inventory_sha:raise ValueError('Wrong source/image/manifest')
 metadata=decode_json(read(directory/'qualification.json',65536))
 exact={'source':inventory['source'],'image':request['imageDigest'],'harnessDigest':request['harnessDigest'],'tree':inventory['tree'],'parents':inventory['parents'],'lockSha256':inventory['lockSha256'],'inventorySha256':inventory_sha,'status':0,'checkoutRoots':{lane:'/work/'+lane for lane in LANES},'installCount':4,'unitWorkers':16,'generalWorkers':2,'gridWorkers':1,'clipboardWorkers':1}
 if not isinstance(metadata,dict) or any(metadata.get(k)!=v for k,v in exact.items()) or type(metadata.get('status')) is not int:raise ValueError('Root qualification metadata differs')
 if type(metadata.get('wallSeconds')) is not int or not 0<metadata['wallSeconds']<=1900 or type(metadata.get('queueSeconds')) is not int or not 0<=metadata['queueSeconds']<=1800:raise ValueError('Invalid elapsed metadata')
 stamps=[]
 for field in ('queueStartedUtc','startedUtc','finishedUtc'):
  value=metadata.get(field)
  if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ',value):raise ValueError('Invalid UTC metadata')
  stamps.append(datetime.datetime.strptime(value,'%Y-%m-%dT%H:%M:%SZ'))
 if abs(int((stamps[1]-stamps[0]).total_seconds())-metadata['queueSeconds'])>1 or abs(int((stamps[2]-stamps[1]).total_seconds())-metadata['wallSeconds'])>1:raise ValueError('UTC/elapsed metadata differ')
 tools=decode_json(read(directory/'tools.json',65536))
 if not isinstance(tools,dict) or not str(tools.get('node','')).startswith('v24.') or tools.get('pnpm')!=inventory['tools']['pnpm'] or tools.get('nativeTypeScript')!=inventory['tools']['nativeTypeScript'] or not isinstance(tools.get('bun'),str):raise ValueError('Runtime tools differ')
 validate_provenance(directory,inventory)
 times=phase_times(directory)
 smoke=validate_smoke(decode_json(read(directory/'smoke.json',65536)),inventory)
 trace_summary(directory,smoke)
 reports={phase:report_counts(decode_json(read(directory/(phase+'.json'))),phase,inventory) for phase in REPORTS}
 proof=decode_json(read(directory/'coverage.json',65536))
 if not isinstance(proof,dict) or proof.get('source')!=inventory['source'] or proof.get('tree')!=inventory['tree'] or proof.get('inventorySha256')!=inventory_sha or any(proof.get(k)!=reports['unit'][k] for k in ('files','total','passed','skipped','failed')):raise ValueError('Source coverage proof differs')
 return {'qualified':True,'source':inventory['source'],'image':request['imageDigest'],'wallSeconds':metadata['wallSeconds'],'queueSeconds':metadata['queueSeconds'],'phaseCount':sum(len(v) for v in LANE_PHASES.values()),'guardCount':len(PROVENANCE),'allPhasesPassed':True,'allGuardsClean':True,'phasesSeconds':times,'reports':reports,'requiredElectronFiles':sorted({n for phase,names in inventory['requiredElectron'].items() if phase!='grid' for n in names}),'tools':tools,'smoke':smoke,'lockSha256':inventory['lockSha256'],'inventorySha256':inventory_sha}
