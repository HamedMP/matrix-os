import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
export interface BuildSandboxPaths { source: string; dependencies: string; driver: string; nodeRoot: string; unit: string; uid: number }
export function sandboxAvailable(probe: {platform?:NodeJS.Platform;uid?:number;exists?:(path:string)=>boolean} = {}): boolean {
  const uid=probe.uid??process.getuid?.(); const exists=probe.exists??existsSync;
  return (probe.platform??process.platform)==='linux' && typeof uid==='number' && uid>0
    && ['/usr/bin/bwrap','/usr/bin/systemd-run','/usr/bin/systemctl',`/run/user/${uid}/bus`].every(exists);
}
function path(value:string):string {
  if (!isAbsolute(value)||/[\0\r\n:%]/.test(value)||value.split('/').includes('..')) throw new Error('Invalid build path');
  return value;
}
export function buildSandboxLaunch(input:BuildSandboxPaths):{command:string;args:string[];env:Record<string,string>} {
  for (const value of [input.source,input.dependencies,input.driver,input.nodeRoot]) path(value);
  if (!/^matrix-store-build-[a-z0-9]{4,64}$/.test(input.unit)||!Number.isSafeInteger(input.uid)||input.uid<=0) throw new Error('Invalid build identity');
  const runtime=`/run/user/${input.uid}`;
  return {command:'/usr/bin/systemd-run',env:{PATH:'/usr/bin:/bin',XDG_RUNTIME_DIR:runtime,DBUS_SESSION_BUS_ADDRESS:`unix:path=${runtime}/bus`},args:[
    '--user','--pipe','--wait','--collect','--quiet',`--unit=${input.unit}`,'--service-type=exec',
    '--property=MemoryMax=1073741824','--property=CPUQuota=200%','--property=TasksMax=128',
    '--property=RuntimeMaxSec=120','--property=TimeoutStopSec=5','--property=KillMode=control-group',
    '--','/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv',
    '--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind-try','/lib64','/lib64',
    '--ro-bind',input.nodeRoot,'/opt/matrix/runtime/node','--proc','/proc','--dev','/dev',
    '--tmpfs','/tmp','--tmpfs','/workspace','--dir','/home',
    '--ro-bind',input.source,'/source','--ro-bind',input.dependencies,'/deps','--ro-bind',input.driver,'/driver.mjs',
    '--setenv','PATH','/opt/matrix/runtime/node/bin:/usr/bin:/bin','--setenv','HOME','/workspace/home',
    '--setenv','CI','1','--setenv','NODE_OPTIONS','--max-old-space-size=768',
    '--chdir','/workspace','/opt/matrix/runtime/node/bin/node','/driver.mjs',
  ]};
}
