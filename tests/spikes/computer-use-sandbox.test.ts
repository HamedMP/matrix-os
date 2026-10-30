import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const modulePath = resolve('scripts/spikes/computer-use/isolation/sandbox.py');
function python(body: string) {
  return spawnSync('python3', ['-I', '-c', `import importlib.util,tempfile,pathlib,os,socket,json,sys\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location('sandbox',${JSON.stringify(modulePath)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n${body}`], { encoding: 'utf8', timeout: 10000 });
}

describe('isolated Main desktop launcher', () => {
  it('binds only synthetic desktop state and starts a private network with no inherited environment', () => {
    const result = python(`args=m.build_outer('/safe/bundle','/safe/state/desktop',{'net':'net:[1]','mnt':'mnt:[2]','pid':'pid:[3]'},[1,2])\nprint(json.dumps(args))`);
    expect(result.status, result.stderr).toBe(0);
    const argv: string[] = JSON.parse(result.stdout);
    expect(argv).toContain('--unshare-net');
    expect(argv).toContain('--clearenv');
    expect(argv).toContain('/safe/state/desktop/relay');
    expect(argv.join(' ')).not.toMatch(/state\/host|\/home\/matrix|--no-sandbox|--share-net/);
    expect(argv).toContain('/qual/code/isolation/sandbox.py');
    expect(argv).toContain('/safe/bundle/code');
    expect(argv).toContain('/safe/bundle/deps');
    expect(argv).not.toContain('/safe/bundle');
    expect(argv.join(' ')).not.toContain('node_modules');
  });

  it('drops every capability inside a second user namespace while retaining only private writable mounts', () => {
    const result = python(`print(json.dumps(m.build_inner('{}')))`);
    expect(result.status, result.stderr).toBe(0);
    const argv: string[] = JSON.parse(result.stdout);
    expect(argv.slice(argv.indexOf('--uid'), argv.indexOf('--uid') + 4)).toEqual(['--uid', '999', '--gid', '999']);
    expect(argv.slice(argv.indexOf('--cap-drop'), argv.indexOf('--cap-drop') + 2)).toEqual(['--cap-drop', 'ALL']);
    expect(argv).toContain('/qual/code/isolation/desktop.py');
    expect(argv).not.toContain('--cap-add');
    expect(argv).not.toContain('--share-net');
  });

  it('never exposes the X11 source parent as a writable alias that can be swapped before executor mount', () => {
    const result = python(`outer=m.build_outer('/safe/bundle','/safe/state/desktop',{},[1,2]);inner=m.build_inner('{}')\nprint(json.dumps([outer,inner]))`);
    expect(result.status, result.stderr).toBe(0);
    const [outer, inner]: string[][] = JSON.parse(result.stdout);
    expect(outer).not.toContain('/safe/state/desktop');
    expect(inner).not.toContain('/state');
    expect(outer).toContain('/safe/state/desktop/relay');
    expect(outer).toContain('/safe/state/desktop/proxy.sock');
    expect(outer).toContain('/safe/state/desktop/viewer-bootstrap');
    expect(outer).not.toContain('/state/x11');
  });

  it('rejects overlapping bundle/state and symlink state before creating desktop files', () => {
    const result = python(`with tempfile.TemporaryDirectory() as t:\n p=pathlib.Path(t);b=p/'bundle';b.mkdir(mode=0o700);s=b/'state';s.mkdir(mode=0o700)\n try:m.prepare(str(b),str(s));raise AssertionError('overlap allowed')\n except ValueError:pass\n target=p/'target';target.mkdir(mode=0o700);link=p/'link';link.symlink_to(target)\n try:m.prepare(str(b),str(link));raise AssertionError('symlink allowed')\n except ValueError:pass\n assert not (s/'desktop').exists()\nprint('denied')`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('denied');
  });

  it('refuses a non-socket egress proxy and unsafe permissions', () => {
    const result = python(`with tempfile.TemporaryDirectory() as t:\n p=pathlib.Path(t);b=p/'bundle';b.mkdir(mode=0o700);s=p/'state';s.mkdir(mode=0o700);d=s/'desktop';d.mkdir(mode=0o700);(d/'proxy.sock').write_text('fake')\n try:m.prepare(str(b),str(s));raise AssertionError('fake proxy allowed')\n except ValueError:pass\n (d/'proxy.sock').unlink();sock=socket.socket(socket.AF_UNIX);sock.bind(str(d/'proxy.sock'));s.chmod(0o755)\n try:m.prepare(str(b),str(s));raise AssertionError('unsafe mode allowed')\n except ValueError:pass\n sock.close()\nprint('denied')`);
    expect(result.status, result.stderr).toBe(0);
  });

  it('never follows a synthetic desktop symlink during host-side secret cleanup', () => {
    const result = python(`with tempfile.TemporaryDirectory() as t:\n p=pathlib.Path(t);d=p/'desktop';d.mkdir(mode=0o700);h=d/'home';h.mkdir(mode=0o700);(d/'relay').mkdir();outside=p/'outside';outside.mkdir();protected=outside/'qualification.passwd';protected.write_text('preserve')\n (h/'.vnc').symlink_to(outside,target_is_directory=True);(d/'relay/viewer.sock').symlink_to(protected)\n m.cleanup_desktop_files(d)\n assert protected.read_text() == 'preserve'\n assert not (d/'relay/viewer.sock').is_symlink()\n (h/'.vnc').unlink();(h/'.vnc').mkdir();secret=h/'.vnc/qualification.passwd';secret.write_text('test-only')\n m.cleanup_desktop_files(d);m.cleanup_desktop_files(d)\n assert not secret.exists()\nprint('safe')`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('safe');
  });

  it('drains a real owned process group, including its descendant', () => {
    const result = python(`import subprocess,time,signal\np=subprocess.Popen(['/bin/sh','-c','sleep 30 & wait'],start_new_session=True)\nm.stop_group(p)\nassert p.poll() is not None\ntry:os.killpg(p.pid,0);raise AssertionError('group alive')\nexcept ProcessLookupError:pass\nprint('stopped')`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('stopped');
  });
});

it('sanitizes desktop startup phases before returning failure metadata',()=>{
  const result=python(`assert m.DesktopStartupError('xvnc').phase == 'xvnc'\nassert m.DesktopStartupError('/private/password').phase is None\nprint('safe')`);
  expect(result.status,result.stderr).toBe(0);expect(result.stdout.trim()).toBe('safe');
});


it('returns fixed startup error categories without echoing stderr paths or secrets', () => {
  const result = python(`spec=importlib.util.spec_from_file_location('desktop',${JSON.stringify(resolve('scripts/spikes/computer-use/isolation/desktop.py'))})
desktop=importlib.util.module_from_spec(spec);spec.loader.exec_module(desktop)
cases=[(b'Unrecognized option: -secret-FRESH_PASSWORD','unsupported_option'),(b'error while loading shared libraries: /private/secret.so: cannot open shared object file','missing_shared_library'),(b'Fatal server error: Cannot establish any listening sockets','socket_binding'),(b'Failed to move to new namespace: Operation not permitted','sandbox_unavailable'),(b'could not open default font fixed','font_unavailable'),(b'No such file or directory: /private/secret','missing_runtime_file'),(b'arbitrary SECRET content','unclassified')]
for raw,want in cases: assert desktop.classify_startup(raw)==want
print('classified')`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('classified');
});


it('bounds real startup stderr and discards its contents when startup succeeds', () => {
  const result = python(`import subprocess
spec=importlib.util.spec_from_file_location('desktop',${JSON.stringify(resolve('scripts/spikes/computer-use/isolation/desktop.py'))})
desktop=importlib.util.module_from_spec(spec);spec.loader.exec_module(desktop)
child=subprocess.Popen([sys.executable,'-I','-c',"import sys;sys.stderr.write('SECRET'*40000)",],stderr=subprocess.PIPE)
diag=desktop.StartupDiagnostic(child);child.wait(timeout=3);diag.thread.join(timeout=1)
assert len(diag.data)<=8192
result=diag.snapshot();assert result['stderr_bytes']==65536 and result['truncated'] is True
assert 'SECRET' not in json.dumps(result)
diag.discard();assert diag.snapshot() is None
print('bounded')`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('bounded');
});

it('allowlists diagnostic fields through the outer launcher failure boundary', () => {
  const result = python(`raw={'service':'xvnc','code':'unsupported_option','exit_code':1,'stderr_bytes':8192,'truncated':True,'raw':'SECRET'}
safe=m.DesktopStartupError('xvnc',raw).diagnostic
assert safe is not None and safe['code']=='unsupported_option' and 'raw' not in safe
assert 'SECRET' not in json.dumps(safe)
assert m.DesktopStartupError('xvnc',{'service':'xvnc','code':[]}).diagnostic is None
assert m.DesktopStartupError('xvnc',{'service':'xvnc','code':'SECRET'}).diagnostic is None
assert m.DesktopStartupError('xvnc',{'service':'xvnc','code':'resource_limit','errno':11,'raw':'SECRET'}).diagnostic == {'service':'xvnc','code':'resource_limit','errno':11}
assert 'errno' not in m.DesktopStartupError('xvnc',{'service':'xvnc','code':'unclassified','errno':True}).diagnostic
print('safe')`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('safe');
});


it('classifies pre-Popen Xvnc failure without requiring a stderr pipe or exposing exception text', () => {
  const result = python(`import errno
spec=importlib.util.spec_from_file_location('desktop',${JSON.stringify(resolve('scripts/spikes/computer-use/isolation/desktop.py'))})
desktop=importlib.util.module_from_spec(spec);spec.loader.exec_module(desktop)
for number,want in [(errno.ENOENT,'missing_runtime_file'),(errno.EACCES,'permission_denied'),(errno.EAGAIN,'resource_limit'),(errno.ENOEXEC,'invalid_executable'),(errno.EIO,'unclassified')]:
 def fail(*args,**kwargs):raise OSError(number,'SECRET raw text','/private/FRESH_PASSWORD')
 desktop.subprocess.Popen=fail
 try:desktop.spawn_desktop(['/usr/bin/Xkasmvnc',':7']);raise AssertionError('failure ignored')
 except OSError as error:
  diagnostic=getattr(error,'diagnostic',None)
  assert diagnostic=={'service':'xvnc','code':want,'errno':number}
  assert 'SECRET' not in json.dumps(diagnostic) and 'private' not in json.dumps(diagnostic)
print('safe')`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('safe');
});

it('pins Xkasmvnc directly because the Xvnc alternatives link dangles in minimal etc', () => {
  const result = python(`source=pathlib.Path(${JSON.stringify(resolve('scripts/spikes/computer-use/isolation/desktop.py'))}).read_text()
assert "XVNC_PROGRAM = '/usr/bin/Xkasmvnc'" in source
assert 'launch([XVNC_PROGRAM,' in source
assert "argv[0] == XVNC_PROGRAM" in source
assert "'/usr/bin/Xvnc'" not in source
print('canonical')`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('canonical');
});


it('preserves the observed Chrome failure before cleanup while healthy Xvnc stays unattributed', () => {
  const result = python(`import types
spec=importlib.util.spec_from_file_location('desktop',${JSON.stringify(resolve('scripts/spikes/computer-use/isolation/desktop.py'))})
desktop=importlib.util.module_from_spec(spec);spec.loader.exec_module(desktop)
status={'xvnc':None,'chrome':7}
required=[(name,types.SimpleNamespace(poll=lambda name=name:status[name])) for name in ('xvnc','chrome')]
try:desktop.require_running(required);raise AssertionError('exited Chrome ignored')
except ValueError as error:
 diagnostic=getattr(error,'diagnostic',None)
 status.update(xvnc=1,chrome=-15)
 assert diagnostic=={'service':'chrome','code':'unclassified','exit_code':7}
 assert desktop.FIRST_REQUIRED_FAILURE==diagnostic
assert m.DesktopStartupError('desktop_apps',diagnostic).diagnostic==diagnostic
print('preserved')`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('preserved');
});

it('retains classified Xvnc failure detail without overwriting the first observed service or exit', () => {
  const result=python(`spec=importlib.util.spec_from_file_location('desktop',${JSON.stringify(resolve('scripts/spikes/computer-use/isolation/desktop.py'))})
desktop=importlib.util.module_from_spec(spec);spec.loader.exec_module(desktop)
desktop.FIRST_REQUIRED_FAILURE={'service':'xvnc','code':'unclassified','exit_code':1}
desktop.STARTUP_FAILURE_DIAGNOSTIC={'service':'xvnc','code':'unsupported_option','exit_code':-15,'stderr_bytes':48,'truncated':False}
result=desktop.failure_diagnostic(ValueError())
assert result=={'service':'xvnc','code':'unsupported_option','exit_code':1,'stderr_bytes':48,'truncated':False}
desktop.FIRST_REQUIRED_FAILURE={'service':'chrome','code':'unclassified','exit_code':7}
assert desktop.failure_diagnostic(ValueError())==desktop.FIRST_REQUIRED_FAILURE
print('preserved')`);
  expect(result.status,result.stderr).toBe(0);expect(result.stdout.trim()).toBe('preserved');
});
