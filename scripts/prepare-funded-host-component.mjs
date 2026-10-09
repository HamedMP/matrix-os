#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [agentPath, componentPath] = process.argv.slice(2);
if (!agentPath || !componentPath) throw new Error("usage: prepare-funded-host-component.mjs <staged-agent> <staged-component-dir>");
const source = join(root, "distro/customer-vps/funded-host-config");
const [bootstrap, runtime, recovery, repair, agent] = await Promise.all([
  readFile(join(source, "install.py"), "utf8"), readFile(join(source, "reconcile.py"), "utf8"),
  readFile(join(source, "recovery.py"), "utf8"),
  readFile(join(root, "scripts/ops/repair-funded-chat-config.py"), "utf8"), readFile(agentPath, "utf8"),
]);
const pattern = /# BEGIN funded host bootstrap[\s\S]*?# END funded host bootstrap/g;
if (agent.match(pattern)?.length !== 1) throw new Error("missing funded bootstrap marker");
const entry = `
def entry():
    require(os.geteuid() == 0 and len(sys.argv) == 2)
    if sys.argv[1] == '--maintenance':
        maintenance()
    elif sys.argv[1] == '--rollback':
        run('rollback')
    elif sys.argv[1] == '--resume':
        resume()
    elif sys.argv[1] in ('--recovery-check', '--recovery-preflight'):
        recovery_proof(sys.argv[1] == '--recovery-preflight')
    else:
        raise ConfigError('configuration_deferred')
try:
    entry()
except Exception:
    print('{"error":"configuration_deferred"}', file=sys.stderr)
    sys.exit(1)
`;
await mkdir(componentPath, { recursive: true });
await writeFile(join(componentPath, "reconcile.py"), `${bootstrap}\n${runtime}\n${recovery}\nREPAIR_SOURCE = ${JSON.stringify(repair)}\n${entry}`, "utf8");
await copyFile(join(source, "matrix-funded-host-config.service"), join(componentPath, "matrix-funded-host-config.service"));
const invocation = `
import sys
try:
    require(os.geteuid() == 0 and len(sys.argv) == 4 and sys.argv[1] in ('install', 'schedule', 'retry', 'rollback', 'recovery-check', 'recovery-preflight'))
    if sys.argv[1].startswith('recovery-'):
        state = Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
        lib = Directory('/', ('usr', 'local', 'libexec'))
        try:
            receipt = json_bytes(state.read('receipt.json'))
            code = lib.read('matrix-funded-host-config.py')
            require(digest(code) == receipt['componentSha256'])
        finally:
            lib.close()
            state.close()
        sys.argv = ['/usr/local/libexec/matrix-funded-host-config.py', '--' + sys.argv[1]]
        exec(compile(code, '<verified-installed-funded-component>', 'exec'), {'__name__': '__main__'})
        sys.exit(0)
    fd = os.open('/opt/matrix/release.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and info.st_nlink == 1 and info.st_size <= 65536)
        release = json_bytes(os.read(fd, 65537))
    finally:
        os.close(fd)
    require(release['version'] == sys.argv[2])
    if sys.argv[1] == 'retry':
        state = Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
        lib = Directory('/', ('usr', 'local', 'libexec'))
        units = Directory('/', ('etc', 'systemd', 'system'))
        try:
            require(not os.path.lexists('/var/lib/matrix-funded-host-config/install-pending.json'))
            receipt = json_bytes(state.read('receipt.json'))
            require(set(receipt) == {'version', 'sourceSha', 'archiveSha256', 'componentSha256', 'unitSha256'}
                    and receipt['version'] == release['version'] and receipt['sourceSha'] == release['gitCommit']
                    and re.fullmatch(r'[a-f0-9]{40}', receipt['sourceSha'])
                    and all(re.fullmatch(r'[a-f0-9]{64}', receipt[key]) for key in ('archiveSha256', 'componentSha256', 'unitSha256'))
                    and digest(lib.read('matrix-funded-host-config.py')) == receipt['componentSha256']
                    and digest(units.read('matrix-funded-host-config.service')) == receipt['unitSha256'])
        finally:
            units.close()
            lib.close()
            state.close()
        schedule(release['version'], release['gitCommit'])
        sys.exit(0)
    install(release['version'], release['gitCommit'], use_staged=sys.argv[1] == 'schedule')
    if sys.argv[1] == 'schedule':
        schedule(release['version'], release['gitCommit'])
    elif sys.argv[1] == 'rollback':
        schedule(release['version'], release['gitCommit'], 'rollback', sys.argv[3])
except Exception:
    print('{"error":"configuration_deferred"}', file=sys.stderr)
    sys.exit(1)
`;
const inlined = `# BEGIN inlined funded host bootstrap
funded_host_bootstrap() {
  sudo /usr/bin/python3 -I - "$1" "\${2:-}" "\${3:-}" <<'MATRIX_FUNDED_VERIFIED_BOOTSTRAP'
${bootstrap}
${invocation}
MATRIX_FUNDED_VERIFIED_BOOTSTRAP
}
# END inlined funded host bootstrap`;
await writeFile(agentPath, agent.replace(pattern, () => inlined), "utf8");
