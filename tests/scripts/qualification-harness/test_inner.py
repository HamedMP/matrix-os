import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from fixtures import ROOT
from contract import ELECTRON as REPORT_FILES,PHASES
HERE=ROOT/'scripts'/'ci'/'qualification'

class InnerContracts(unittest.TestCase):
 def invoke(self,fail=''):
  with tempfile.TemporaryDirectory() as path:
   root=Path(path);work=root/'work';work.mkdir();binary=root/'bin';binary.mkdir()
   pg=root/'fixture-postgres.sh';pg.write_text('start_fixture_postgres() { pgmock start; export MATRIX_PLATFORM_FIXTURE_POSTGRES_URL=postgresql://fixture@127.0.0.1:5432/matrix_ci_platform_fixture_admin; }; stop_fixture_postgres() { pgmock stop; }\n')
   script=root/'benchmark.sh';script.write_text((HERE/'benchmark.sh').read_text().replace('/work',str(work)).replace('/opt/matrix-ci/fixture-postgres.sh',str(pg)))
   helper='''#!PYTHON
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name;args=sys.argv[1:];work=Path(os.environ['MOCK_WORK'])
with open(os.environ['MOCK_LOG'],'a') as output:output.write(json.dumps(dict(cmd=name,args=args,pg=os.environ.get('MATRIX_PLATFORM_FIXTURE_POSTGRES_URL'),provider=os.environ.get('MATRIX_PROVIDER_AUTH_ELECTRON'),required=os.environ.get('MATRIX_DESKTOP_E2E_REQUIRED'),store=os.environ.get('npm_config_store_dir'),cwd=os.getcwd(),cache=os.environ.get('XDG_CACHE_HOME'),browsers=os.environ.get('PLAYWRIGHT_BROWSERS_PATH'),pythoncache=os.environ.get('PYTHONPYCACHEPREFIX')))+'\\n')
if name=='python3' and '--prepare' in args:
 for lane in ('unit','mechanical','web','e2e'):(work/lane).mkdir()
if name=='python3' and '--source-check' in args:
 lane,stage=args[-2:];(work/'results'/('source-'+lane+'-'+stage+'.json')).write_text(json.dumps(dict(clean=not os.environ.get('MOCK_FAIL')==stage,lane=lane,stage=stage)))
 if os.environ.get('MOCK_FAIL')==stage:sys.exit(1)
if name=='node' and '--input-type=module' in args:(work/'results'/'tools.json').write_text('{}')
if name=='xvfb-run':os.execvp(args[1],args[1:])
fail=os.environ.get('MOCK_FAIL')
if fail=='source' and name=='python3' and '--prepare' in args:sys.exit(1)
if fail=='install' and name=='pnpm' and args==['install','--frozen-lockfile']:sys.exit(1)
if fail=='unit' and name=='pnpm' and 'unit.json' in ' '.join(args):sys.exit(1)
if fail=='typecheck' and name=='bun' and args==['run','typecheck:run']:sys.exit(1)
if fail=='brand' and name=='pnpm' and args==['--filter','@matrix-os/brand','build']:sys.exit(1)
if fail=='immutability' and name=='python3' and '--prepare-unit-source' in args:sys.exit(1)
if fail=='pgstop' and name=='pgmock' and args==['stop']:sys.exit(1)
'''.replace('#!PYTHON','#!'+sys.executable)
   for name in ('python3','git','node','pnpm','bun','xvfb-run','pgmock'):
    p=binary/name;p.write_text(helper);p.chmod(0o755)
   env=dict(os.environ,PATH=str(binary)+':'+os.environ['PATH'],MOCK_WORK=str(work),MOCK_LOG=str(root/'log'),MOCK_FAIL=fail)
   result=subprocess.run(['bash',str(script),'1'*40,str(work/'qualification-input.json'),'2'*64],env=env,capture_output=True,text=True,timeout=20)
   calls=[json.loads(line) for line in (root/'log').read_text().splitlines()]
   times={p.name:dict((f[0],int(f[2])) for line in p.read_text().splitlines() for f in [line.split('\t')]) for p in (work/'results').glob('timing-*.tsv')}
   return result,calls,times
 def test_all_inner_phases_native_pg_and_four_cold_installs(self):
  result,calls,times=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
  for lane,phases in PHASES.items():
   if lane!='smoke':self.assertEqual(list(times['timing-'+lane+'.tsv']),list(phases))
  installs=[c for c in calls if c['cmd']=='pnpm' and c['args']==['install','--frozen-lockfile']];self.assertEqual(len(installs),4);self.assertEqual({Path(c['cwd']).name for c in installs},{'unit','mechanical','web','e2e'})
  unit=next(c for c in calls if c['cmd']=='pnpm' and '--maxWorkers=16' in c['args']);self.assertTrue(unit['pg'].startswith('postgresql://'));self.assertIn('/work/pnpm-store',unit['store'])
  self.assertFalse(any('--exclude' in arg or '--shard' in arg or '--testNamePattern' in arg for c in calls for arg in c['args']))
 def test_general_grid_before_desktop_and_exact_required_electron_groups(self):
  result,calls,_=self.invoke();self.assertEqual(result.returncode,0)
  general=next(i for i,c in enumerate(calls) if c['cmd']=='pnpm' and 'general.json' in ' '.join(c['args']))
  grid=next(i for i,c in enumerate(calls) if c['cmd']=='pnpm' and 'grid.json' in ' '.join(c['args']))
  build=next(i for i,c in enumerate(calls) if c['cmd']=='bun' and c['args']==['run','build:desktop'])
  self.assertLess(general,grid);self.assertLess(grid,build)
  groups=[c for c in calls if c['cmd']=='pnpm' and '--config' in c['args'] and c['required']=='1']
  self.assertEqual(len(groups),9)
  actual=[arg for c in groups for arg in c['args'] if arg.startswith('tests/')]
  expected=[path for name,paths in REPORT_FILES.items() if name!='grid' for path in paths]
  self.assertEqual(set(actual),set(expected));self.assertEqual(len(actual),len(expected))
  clipboard=next(c for c in groups if 'electron-clipboard.json' in ' '.join(c['args']));self.assertIn('--maxWorkers=1',clipboard['args'])
  self.assertEqual(sum(c['provider']=='1' for c in groups),1)
 def test_brand_build_is_measured_before_every_lane(self):
  result,calls,times=self.invoke();self.assertEqual(result.returncode,0)
  brand=next(i for i,c in enumerate(calls) if c['cmd']=='pnpm' and c['args']==['--filter','@matrix-os/brand','build'])
  for i,c in enumerate(calls):
   if (c['cmd']=='pnpm' and 'vitest' in c['args']) or (c['cmd']=='bun' and c['args'] in (['run','build:shell:production'],['run','build:desktop'],['run','typecheck:run'])):self.assertLess(brand,i)
  self.assertEqual(times['timing-setup.tsv']['brand-build-unit'],0)
 def test_brand_build_failure_is_fatal_before_test_lanes(self):
  result,calls,times=self.invoke('brand');self.assertNotEqual(result.returncode,0)
  self.assertEqual(times['timing-setup.tsv']['brand-build-unit'],1)
  self.assertFalse(any(c['cmd']=='pnpm' and 'vitest' in c['args'] for c in calls))
 def test_unverified_source_prevents_install_and_app_execution(self):
  result,calls,_=self.invoke('source');self.assertNotEqual(result.returncode,0);self.assertFalse(any(c['cmd'] in ('pnpm','bun') for c in calls))
 def test_lane_roots_and_external_caches_are_exact_and_disjoint(self):
  result,calls,_=self.invoke();self.assertEqual(result.returncode,0)
  for c in calls:
   if c['cmd'] in ('pnpm','bun'):
    lane=Path(c['cwd']).name
    self.assertIn(lane,('unit','mechanical','web','e2e'))
    self.assertFalse(c['cache'].startswith(c['cwd']+'/'));self.assertFalse(c['browsers'].startswith(c['cwd']+'/'))
  unit=next(c for c in calls if c['cmd']=='pnpm' and 'unit.json' in ' '.join(c['args']));self.assertEqual(Path(unit['cwd']).name,'unit')
  web=next(c for c in calls if c['cmd']=='bun' and c['args']==['run','build:shell:production']);self.assertEqual(Path(web['cwd']).name,'web')
  e2e=next(c for c in calls if c['cmd']=='pnpm' and 'general.json' in ' '.join(c['args']));self.assertEqual(Path(e2e['cwd']).name,'e2e')
 def test_provenance_checks_precede_desktop_and_release_even_other_failures(self):
  result,calls,_=self.invoke('unit');self.assertNotEqual(result.returncode,0)
  checks={c['args'][-1]:i for i,c in enumerate(calls) if c['cmd']=='python3' and '--source-check' in c['args']}
  desktop=next(i for i,c in enumerate(calls) if c['cmd']=='bun' and c['args']==['run','build:desktop'])
  release=next(i for i,c in enumerate(calls) if c['cmd']=='pnpm' and 'electron-release.json' in ' '.join(c['args']))
  self.assertLess(checks['before-desktop'],desktop);self.assertLess(checks['before-release'],release)
 def test_install_failure_still_captures_postinstall_provenance(self):
  result,calls,_=self.invoke('install');self.assertNotEqual(result.returncode,0)
  self.assertTrue(any(c['cmd']=='python3' and c['args'][-1]=='postinstall' for c in calls))
  self.assertFalse(any(c['cmd']=='bun' for c in calls))
 def test_postinstall_dirty_stops_before_any_app_execution(self):
  result,calls,_=self.invoke('postinstall');self.assertNotEqual(result.returncode,0)
  self.assertFalse(any(c['cmd']=='bun' or (c['cmd']=='pnpm' and ('vitest' in c['args'] or 'build' in c['args'])) for c in calls))
 def test_dirty_e2e_stops_affected_lane_but_records_release_diagnostic(self):
  result,calls,times=self.invoke('before-desktop');self.assertNotEqual(result.returncode,0)
  self.assertFalse(any(c['cmd']=='bun' and c['args']==['run','build:desktop'] for c in calls))
  self.assertTrue(any(c['cmd']=='python3' and c['args'][-1]=='before-release' for c in calls))
  self.assertIn('shell',times['timing-web.tsv']);self.assertIn('source-coverage-proof',times['timing-unit.tsv'])
 def test_unit_failure_retains_all_lanes_proofs_and_pg_teardown(self):
  result,_,times=self.invoke('unit');self.assertNotEqual(result.returncode,0);self.assertEqual(times['timing-unit.tsv']['unit'],1)
  self.assertIn('source-coverage-proof',times['timing-unit.tsv']);self.assertIn('shell',times['timing-web.tsv']);self.assertIn('electron-title',times['timing-e2e.tsv']);self.assertIn('postgres-stop',times['timing-cleanup.tsv'])
 def test_typecheck_or_native_pg_teardown_failure_is_fatal(self):
  for failure in ('typecheck','pgstop'):
   result,_,times=self.invoke(failure);self.assertNotEqual(result.returncode,0);self.assertIn('electron-title',times['timing-e2e.tsv'])

 def test_unit_source_lease_precedes_unit_and_failure_blocks_all_lanes(self):
  result,calls,times=self.invoke();self.assertEqual(result.returncode,0)
  lease=next(i for i,c in enumerate(calls) if c['cmd']=='python3' and '--prepare-unit-source' in c['args'])
  unit=next(i for i,c in enumerate(calls) if c['cmd']=='pnpm' and 'unit.json' in ' '.join(c['args']))
  self.assertLess(lease,unit);self.assertEqual(times['timing-setup.tsv']['unit-source-immutability'],0)
  result,calls,times=self.invoke('immutability');self.assertNotEqual(result.returncode,0)
  self.assertEqual(times['timing-setup.tsv']['unit-source-immutability'],1)
  self.assertFalse(any(c['cmd']=='pnpm' and 'vitest' in c['args'] for c in calls))
 def test_python_cache_prefix_is_fixed_outside_each_source_checkout(self):
  result,calls,_=self.invoke();self.assertEqual(result.returncode,0)
  for c in calls:
   if c['cmd'] in ('pnpm','bun'):
    lane=Path(c['cwd']).name;self.assertIn(lane,('unit','mechanical','web','e2e'))
    self.assertEqual(c['pythoncache'],str(Path(c['cwd']).parent/'cache'/lane/'python').removeprefix('/private'))
    self.assertFalse(c['pythoncache'].startswith(c['cwd']+'/'))

if __name__=='__main__':unittest.main()
