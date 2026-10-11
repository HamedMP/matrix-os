#!/usr/bin/python3 -I
"""Trusted root Docker lifecycle/evidence; public source runs exclusively UID10001."""
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
import time
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_command import host_command as command
from lease_config import read_owned, read_owned_json
from lease_contract import canonical_digest, hex_value, LIMITS
from lease_store import LeaseStore

MAX_FILE = 50 * 1024 * 1024
MAX_TOTAL = 150 * 1024 * 1024
MAX_MANIFEST = 2 * 1024 * 1024
HOST_FILES = {'qualification.json','source-sha','image-id','inventory-sha256','exit-code',
              'benchmark-exit-code','smoke-exit-code','smoke.json','smoke.stderr.log','output.log',
              'trace','timing-smoke.tsv',
              *('host-source-'+lane+'.json' for lane in ('unit','mechanical','web','e2e'))}


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('Untrusted root state directory')


def exclusive(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as output:
        output.write(data)


def write_json(path, value):
    exclusive(path, json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode() + b'\n')


def copy_member(data, destination, expected):
    created = False
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r|') as archive:
            count = 0
            for member in archive:
                count += 1
                if count != 1 or not member.isreg() or member.name != expected or not 0 <= member.size <= MAX_FILE:
                    raise ValueError('Invalid fixed regular artifact')
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError('Missing artifact contents')
                fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                created = True
                with os.fdopen(fd, 'wb') as output:
                    remaining = member.size
                    while remaining:
                        chunk = source.read(min(65536, remaining))
                        if not chunk:
                            raise ValueError('Truncated artifact')
                        output.write(chunk)
                        remaining -= len(chunk)
            if count != 1:
                raise ValueError('Missing artifact')
    except (OSError, ValueError, tarfile.TarError):
        if created:
            Path(destination).unlink()
        raise


class QualificationHost:
    def __init__(self, root, lease, request, *, execute=command):
        if not hex_value(lease, 32) or request.get('limits') != LIMITS:
            raise ValueError('Invalid approved workload identity')
        self.root, self.lease, self.request = Path(root), lease, request
        self.execute = execute
        self.name = 'matrix-ci-lease-' + lease
        self.digest = canonical_digest(request)
        private_dir(self.root)
        private_dir(self.root / 'results')
        from lease_retention import cleanup_results
        cleanup_results(self.root)
        self.lease_dir = self.root / 'results' / ('lease.' + lease)
        self.result = self.lease_dir / 'evidence'
        # Root-owned cleanup-host.sh has recurring retention. Never silently
        # evict uncertain active/replay evidence to make space for new requests.
        if not self.lease_dir.exists() and len(list((self.root / 'results').iterdir())) >= 32:
            raise ValueError('Qualification result directory cap; operator retention required')
        private_dir(self.lease_dir)
        private_dir(self.result)
        filename = self.lease_dir / 'request.json'
        if filename.exists():
            if read_owned_json(filename, os.getuid()) != request:
                raise ValueError('Existing lease source differs')
        else:
            write_json(filename, request)
            write_json(self.lease_dir / 'queued.json', dict(queueStartedUtc=utc(), queueStartedEpoch=time.time()))

    def modules(self):
        parent = Path(__file__).resolve().parent
        directory = parent / 'qualification' if (parent / 'qualification').is_dir() else parent.parent / 'qualification'
        sys.path.insert(0, str(directory))
        return directory

    def no_leftovers(self):
        found = self.execute(['docker','container','ls','-a','--filter','label=matrix-ci.disposable=true','--format','{{.ID}}'], timeout=10, cap=65536)
        if found.returncode or found.stdout.strip():
            raise ValueError('Disposable container admission blocked')

    def preflight(self):
        cores = self.execute(['nproc'], timeout=5, cap=1024)
        with open('/proc/meminfo') as info:
            memory = info.read(65536)
        match = re.search(r'^MemTotal:\s+([0-9]+) kB$', memory, re.M)
        if cores.returncode or not cores.stdout.strip().isdigit() or int(cores.stdout) < 32 or not match or int(match[1]) < 120000000:
            raise ValueError('Approved CPU/memory capacity unavailable')
        for args in (['iptables','-C','DOCKER-USER','-i','matrix-ci0','-j','MATRIX-CI-EGRESS'],
                     ['iptables','-C','INPUT','-i','matrix-ci0','-j','REJECT']):
            if self.execute(args, timeout=5).returncode:
                raise ValueError('Required private-egress isolation unavailable')
        image = self.execute(['docker','image','inspect','--format','{{.Id}}',self.request['imageDigest']], timeout=10, cap=1024)
        if image.returncode or image.stdout.decode().strip() != self.request['imageDigest']:
            raise ValueError('Approved immutable image unavailable')
        self.no_leftovers()
        queued = read_owned_json(self.lease_dir / 'queued.json', os.getuid())
        started = time.time()
        write_json(self.lease_dir / 'started.json', dict(startedUtc=utc(), startedEpoch=started,
            queueStartedUtc=queued['queueStartedUtc'], queueSeconds=int(started - queued['queueStartedEpoch'])))
        return True

    def create_args(self):
        return ['docker','create','--init','--name',self.name,
            '--label','matrix-ci.disposable=true','--label','matrix-ci.lease='+self.lease,
            '--label','matrix-ci.request='+self.digest,
            '--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges:true',
            '--cpus','30','--memory','112g','--memory-swap','112g','--pids-limit','4096','--shm-size','2g',
            '--read-only','--tmpfs','/work:rw,exec,nosuid,nodev,size=64g,uid=10001,gid=10001,mode=0755',
            '--tmpfs','/tmp:rw,exec,nosuid,nodev,size=8g,mode=1777',
            '--tmpfs','/home/runner:rw,nosuid,nodev,size=1g,uid=10001,gid=10001,mode=0755',
            '--network','matrix-ci','--dns','1.1.1.1','--dns','1.0.0.1',
            '--log-opt','max-size=10m','--log-opt','max-file=2',self.request['imageDigest']]

    def cleanup(self):
        inspected = self.execute(['docker','container','ls','-a','--filter','name=^/'+self.name+'$','--format','{{.ID}}'], timeout=5, cap=1024)
        if inspected.returncode:
            return False
        if not inspected.stdout.strip():
            return True
        identity = self.execute(['docker','inspect',self.name], timeout=5, cap=65536)
        try:
            rows = json.loads(identity.stdout)
            labels = rows[0]['Config']['Labels']
            if (identity.returncode or len(rows) != 1 or labels.get('matrix-ci.lease') != self.lease
                    or labels.get('matrix-ci.request') != self.digest or labels.get('matrix-ci.disposable') != 'true'):
                return False
        except (ValueError, KeyError, TypeError, IndexError) as error:
            print('Owned container identity rejected: ' + type(error).__name__, file=sys.stderr)
            return False
        removed = self.execute(['docker','rm','--force',self.name], timeout=10, cap=65536)
        if removed.returncode:
            return False
        gone = self.execute(['docker','container','ls','-a','--filter','name=^/'+self.name+'$','--format','{{.ID}}'], timeout=5, cap=1024)
        return gone.returncode == 0 and not gone.stdout.strip()

    def collect(self, files):
        total = sum(p.lstat().st_size for p in self.result.iterdir() if p.is_file())
        for name in files:
            if name in HOST_FILES:
                continue
            result = self.execute(['docker','exec','--user','10001:10001',self.name,
                '/usr/bin/tar','-cf','-','-C','/work/results','--',name], timeout=30, cap=MAX_FILE+65536)
            if result.returncode:
                print('Qualification artifact unavailable: ' + name, file=sys.stderr)
                continue # Diagnostics preserved; final validator rejects absent mandatory data.
            destination = self.result / name
            copy_member(result.stdout, destination, name)
            total += destination.lstat().st_size
            if total > MAX_TOTAL:
                raise ValueError('Qualification artifact aggregate exceeds bound')

    def final_source_checks(self, inventory_sha):
        clean = True
        for lane in ('unit','mechanical','web','e2e'):
            destination = self.result / ('host-source-'+lane+'.json')
            try:
                probe = self.execute(['docker','exec','--user','10001:10001',self.name,
                    '/usr/bin/python3','-I','/opt/matrix-ci/qualification/source.py',
                    self.request['mergeSha'],'/work/qualification-input.json',inventory_sha,
                    '--host-final-check',lane], timeout=120, cap=320*1024)
                if len(probe.stdout) > 256*1024 or len(probe.stderr) > 64*1024:
                    raise ValueError('Independent source probe output exceeds bound')
                exclusive(destination, probe.stdout)
                proof = json.loads(probe.stdout)
                if (probe.returncode or not isinstance(proof, dict) or proof.get('clean') is not True
                        or proof.get('source') != self.request['mergeSha'] or proof.get('lane') != lane
                        or proof.get('inventorySha256') != inventory_sha):
                    raise ValueError('Independent source probe rejected')
            except Exception as error:
                clean = False
                print('Independent source check failed: '+lane+' '+type(error).__name__, file=sys.stderr)
                if not destination.exists():
                    write_json(destination, dict(clean=False,lane=lane,source=self.request['mergeSha'],
                        inventorySha256=inventory_sha,error='host_probe_failed'))
        return clean

    def run(self):
        self.modules()
        from manifest import check_manifest
        from contract import ARTIFACTS
        from validate import web_phase_ready
        manifest = None
        inventory_sha = None
        exclusive(self.result / 'source-sha', (self.request['mergeSha']+'\n').encode())
        exclusive(self.result / 'image-id', (self.request['imageDigest']+'\n').encode())
        benchmark_status, smoke_status = 70, 70
        failure = None
        benchmark_finished = False
        try:
            created = self.execute(self.create_args(), timeout=30, cap=1024)
            if created.returncode or not re.fullmatch(rb'[a-f0-9]{64}\n?', created.stdout):
                raise ValueError('Disposable container creation rejected')
            if self.execute(['docker','start',self.name], timeout=30, cap=1024).returncode:
                raise ValueError('Disposable container startup rejected')
            # Trusted immutable preparer runs before any candidate code. Git
            # objects/checkouts stay in capped UID10001 tmpfs, never host root.
            prepared = self.execute(['docker','exec','--user','10001:10001',self.name,
                '/usr/bin/python3','-I','/opt/matrix-ci/qualification/manifest.py','--prepare-public',
                self.request['mergeSha'],self.request['baseSha'],self.request['headSha']], timeout=120, cap=MAX_MANIFEST+65536)
            if prepared.returncode:
                raise ValueError('Trusted public source inventory unavailable')
            manifest = check_manifest(json.loads(prepared.stdout), self.request)
            raw = json.dumps(manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode() + b'\n'
            if len(raw) > MAX_MANIFEST:
                raise ValueError('Trusted inventory exceeds bound')
            inventory_sha = hashlib.sha256(raw).hexdigest()
            exclusive(self.lease_dir / 'inventory.json', raw)
            exclusive(self.result / 'inventory-sha256', (inventory_sha+'\n').encode())
            injected = self.execute(['docker','exec','--interactive','--user','10001:10001',self.name,
                '/usr/bin/tee','/work/qualification-input.json'], data=raw, timeout=30, cap=MAX_MANIFEST+65536)
            if injected.returncode or injected.stdout != raw:
                raise ValueError('Immutable trusted manifest injection rejected')
            execution = self.execute(['docker','exec','--user','10001:10001',self.name,
                '/opt/matrix-ci/qualification/benchmark.sh',self.request['mergeSha'],
                '/work/qualification-input.json',inventory_sha], timeout=1800, cap=20*1024*1024)
            benchmark_finished = True
            benchmark_status = execution.returncode
            exclusive(self.result / 'output.log', execution.stdout + execution.stderr)
            self.collect(ARTIFACTS)
            smoke_started = time.monotonic()
            if web_phase_ready(self.result, manifest):
                smoke = self.execute(['docker','exec','--user','10001:10001',self.name,
                    '/usr/local/bin/node','/opt/matrix-ci/qualification/smoke.mjs',
                    '/work/web','/work/web/shell/.next/trace','/tmp'], timeout=60, cap=2*1024*1024)
                smoke_status = smoke.returncode
                if len(smoke.stdout) > 1024*1024 or len(smoke.stderr) > 1024*1024:
                    raise ValueError('Smoke stream exceeds bound')
                exclusive(self.result / 'smoke.json', smoke.stdout)
                exclusive(self.result / 'smoke.stderr.log', smoke.stderr)
                # Reviewed fixed trace path, collected by trusted ELF tar only.
                trace = self.execute(['docker','exec','--user','10001:10001',self.name,
                    '/usr/bin/tar','-cf','-','-C','/work/web/shell/.next','--','trace'], timeout=30, cap=MAX_FILE+65536)
                if trace.returncode:
                    raise ValueError('Production trace unavailable')
                copy_member(trace.stdout, self.result / 'trace', 'trace')
            else:
                print('Icon measurement unavailable: Web phase/provenance failed', file=sys.stderr)
            exclusive(self.result / 'timing-smoke.tsv', ('icons\t'+str(int(time.monotonic()-smoke_started))+'\t'+str(smoke_status)+'\n').encode())
        except Exception as error:
            failure = error
            if not (self.result / 'timing-smoke.tsv').exists():
                exclusive(self.result / 'timing-smoke.tsv', b'icons\t0\t70\n')
            print('Qualification workload failed: ' + type(error).__name__, file=sys.stderr)
        finally:
            source_clean = self.final_source_checks(inventory_sha) if manifest is not None and benchmark_finished else False
            cleaned = self.cleanup()
            status = 0 if failure is None and benchmark_status == 0 and smoke_status == 0 and source_clean and cleaned else 70
            for name, value in (('benchmark-exit-code',benchmark_status),('smoke-exit-code',smoke_status)):
                exclusive(self.result / name, (str(value)+'\n').encode())
            started = read_owned_json(self.lease_dir / 'started.json', os.getuid())
            metadata = dict(source=self.request['mergeSha'],tree=manifest['tree'] if manifest else None,parents=self.request['mergeParents'],
                image=self.request['imageDigest'],harnessDigest=self.request['harnessDigest'],
                lockSha256=manifest['lockSha256'] if manifest else None,inventorySha256=inventory_sha,status=status,
                checkoutRoots={lane:'/work/'+lane for lane in ('unit','mechanical','web','e2e')},installCount=4,unitWorkers=16,generalWorkers=2,gridWorkers=1,clipboardWorkers=1,
                queueStartedUtc=started['queueStartedUtc'],startedUtc=started['startedUtc'],finishedUtc=utc(),
                queueSeconds=started['queueSeconds'],wallSeconds=int(time.time()-started['startedEpoch']))
            write_json(self.result / 'qualification.json', metadata)
            exclusive(self.result / 'exit-code', (str(status)+'\n').encode())
            if not cleaned:
                raise RuntimeError('Owned container cleanup failed')
        return status

    def receipt(self):
        self.modules()
        from validate import validate
        manifest = json.loads(read_owned(self.lease_dir / 'inventory.json', os.getuid(), MAX_MANIFEST))
        proof = validate(self.result, manifest, self.request)
        if not self.cleanup():
            raise ValueError('Owned container still present')
        metadata = read_owned_json(self.result / 'qualification.json', os.getuid())
        if sum(p.lstat().st_size for p in self.result.iterdir()) > MAX_TOTAL:
            raise ValueError('Accepted evidence storage exceeds bound')
        fields = {key:proof[key] for key in ('phaseCount','guardCount','allPhasesPassed','allGuardsClean',
            'reports','requiredElectronFiles','smoke','lockSha256','inventorySha256','independentHostSourceChecks')}
        return dict(schemaVersion=1,leaseId=self.lease,requestDigest=self.digest,request=self.request,
            qualified=True,exitCode=0,sourceSha=self.request['mergeSha'],parents=self.request['mergeParents'],
            imageDigest=self.request['imageDigest'],harnessDigest=self.request['harnessDigest'],
            startedUtc=metadata['startedUtc'],finishedUtc=metadata['finishedUtc'],
            queueSeconds=metadata['queueSeconds'],wallSeconds=metadata['wallSeconds'],containerGone=True,**fields)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != 'run' or not hex_value(sys.argv[2],32) or os.geteuid() != 0:
        raise SystemExit(64)
    try:
        root = Path('/var/lib/matrix-ci')
        request = read_owned_json(root/'results'/('lease.'+sys.argv[2])/'request.json')
        raise SystemExit(QualificationHost(root,sys.argv[2],request).run())
    except Exception as error:
        print('Qualification host rejected: '+type(error).__name__,file=sys.stderr)
        raise SystemExit(70) from None
