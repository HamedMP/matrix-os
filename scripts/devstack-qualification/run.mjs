#!/usr/bin/env node
// Explicit credential-free qualification; never a production DevStack launcher.
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { options, command, assertOwner, localFixture, createWorktrees, atomicRevision, cleanupLocal, saveReport } from './host.mjs';
import { remoteProgram, service } from './remote.mjs';

const ignores = ['.git', '.env*', 'node_modules', 'dist', '.local', '.next', '.matrix-build*', 'coverage', '.amp', '.codex'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ensure = (value, message) => { if (!value) throw new Error(message); };

export async function qualify(config) {
  const runId = randomUUID().replaceAll('-', '');
  const root = `${config['target-root']}/qualification-${runId}`;
  const report = {
    schema: 1, kind: 'credential-free-source-sync-qualification', runId, startedAt: new Date().toISOString(),
    limits: ['Synthetic source/HTTP fixtures, not Matrix service or identity/database isolation',
      'Agent stall/restart recovery, not a WAN outage or shared-host capacity test',
      'Only an existing explicitly owned local OrbStack container is used'],
    worktreeCount: config.count, atomicUpdates: [], feedback: [], failures: [], cleanup: {},
  };
  let local, initialized = false, daemonTouched = false, interrupted = false;
  const sessions = [];
  const watchers = [];
  const agentsSeen = [];
  const stopped = new Set();
  const started = new Set();
  const signal = () => { interrupted = true; };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  const active = () => { if (interrupted) throw new Error('Qualification interrupted'); };
  const remote = (op, extra = {}) => {
    const result = JSON.parse(command('docker', ['--context', 'orbstack', 'exec', '--user', config.user,
      config.containerId, 'node', '--input-type=module', '-e', remoteProgram, JSON.stringify({ op, root, runId, ...extra })], { timeoutMs: 20_000 }));
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  };
  const mutagen = args => {
    daemonTouched = true;
    return command(config.mutagen, args, { env: local.env, timeoutMs: args.includes('create') ? 60_000 : 30_000 });
  };
  const rememberAgent = async (workspace,agent) => {
    const until=Date.now()+3000;
    for(;;){
      try{remote('remember-agent',{workspace:workspace.id,agent});break;}
      catch(error){if(error.message!=='Transport agent root ownership mismatch'||Date.now()>=until)throw error;await sleep(100);}
    }
    workspace.agent=agent;agentsSeen.push(agent);
  };
  const request = workspaces => {
    const requestId = 'request-'+randomUUID();
    return { requestId, values: remote('http', { workspaces: workspaces.map(w => w.id), requestId }) };
  };
  const wait = async (workspaces, timeoutMs = 45_000) => {
    const until = Date.now()+timeoutMs;
    let observed;
    while (Date.now()<until) {
      active(); observed=request(workspaces);
      if(observed.values.every((value,index)=>value.status===200&&value.body.workspace===workspaces[index].id
        &&value.body.revision===workspaces[index].revision&&value.body.requestId===observed.requestId)) return observed;
      await sleep(80);
    }
    throw new Error('Expected workspace revisions did not converge: '+JSON.stringify(observed).slice(0,2000));
  };
  const evidence = async workspace => {
    const observed = await wait([workspace]);
    const audit=remote('audit',{workspace:workspace.id});
    const hash=createHash('sha256').update(await readFile(join(workspace.source,'revision.mjs'))).digest('hex');
    ensure(audit.sourceHash===hash,'Runtime marker without source convergence');
    ensure(audit.secretAbsent&&audit.gitAbsent,'Private/VCS sentinel was projected: '+JSON.stringify({secretAbsent:audit.secretAbsent,gitAbsent:audit.gitAbsent}));
    for(const name of ['node_modules','dist','.local'])ensure(audit.sentinels[name]==='generated-'+name,'Target generated state was changed');
    let logs;
    for(let n=0;n<30;n++){
      logs=remote('logs',{workspace:workspace.id});
      if(logs.text.includes(observed.requestId)&&logs.text.includes(workspace.revision))break;
      await sleep(50);
    }
    ensure(logs.text.includes(observed.requestId)&&logs.text.includes(workspace.id),'Correlated agent log missing');
    return {workspace:workspace.id,revision:workspace.revision,requestId:observed.requestId,sourceHash:hash,
      pid:observed.values[0].body.pid,status:200,logCursor:logs.cursor,logBytes:Buffer.byteLength(logs.text)};
  };
  try {
    config.containerId=assertOwner(config);
    report.harness={};
    for(const filename of ['run.mjs','host.mjs','remote.mjs'])report.harness[filename]=createHash('sha256').update(await readFile(new URL(filename,import.meta.url))).digest('hex');
    report.tools={hostNode:process.versions.node,mutagen:command(config.mutagen,['version']).trim()};
    let wrongOwnerRejected=false;
    try { assertOwner(config,config.labelValue+'-deliberate-mismatch'); }
    catch(error){ensure(error.message==='Container ownership label mismatch','Unexpected owner guard result');wrongOwnerRejected=true;}
    ensure(wrongOwnerRejected,'Wrong owner label accepted');report.ownerGuard={wrongOwnerRejected:true};
    local=await localFixture(config);
    report.tools.target=remote('initialize',{tsx:config.tsx});initialized=true;
    const workspaces=await createWorktrees(local,config,service);
    report.workspaces=workspaces.map(w=>({id:w.id,branch:w.branch}));
    for(const workspace of workspaces){
      active();remote('prepare',{workspace:workspace.id});
      const before=remote('agents');
      const name=`q-${runId.slice(0,8)}-${workspace.id}`;
      const endpoint=`docker://${config.user}@${config.containerId}${root}/${workspace.id}/source`;
      const args=['sync','create','--no-global-configuration','--name',name,'--mode','one-way-replica',
        '--ignore-vcs','--symlink-mode','posix-raw','--max-entry-count','1000','--max-staging-file-size','1MB'];
      for(const value of ignores)args.push('--ignore',value);
      // Track before create so partial creation still gets an explicit teardown.
      const session={name,workspace:workspace.id,live:true};sessions.push(session);
      mutagen([...args,workspace.source,endpoint]);
      mutagen(['sync','flush',name]); // Initial setup only, outside measured edits.
      const after=remote('agents');
      const additions=after.filter(a=>!before.some(b=>a.pid===b.pid&&a.start===b.start));
      ensure(additions.length===1,'Cannot uniquely attribute the new transport agent');
      await rememberAgent(workspace,additions[0]);
      if(workspace===workspaces[0])report.partialStartGuard=remote('negative-start',{workspace:workspace.id,tsx:config.tsx});
      const watcher=remote('start',{workspace:workspace.id,tsx:config.tsx}).watcher;
      watchers.push(watcher);started.add(workspace.id);
    }
    await wait(workspaces);
    for(const workspace of workspaces){
      const denied=remote('http',{workspaces:[workspace.id],requestId:'negative-'+randomUUID(),unauthenticated:true});
      ensure(denied[0].status===401,'Fixture accepted an unauthenticated request');
    }
    const cross=remote('http',{workspaces:[workspaces[0].id],tokenWorkspace:workspaces[1].id,requestId:'cross-'+randomUUID()});
    ensure(cross[0].status===401,'Another fixture token admitted across workspaces');
    for(let round=1;round<=3;round++)for(const workspace of workspaces){
      const start=performance.now();
      await atomicRevision(workspace,`${workspace.id}-atomic-${round}`);
      await wait(workspaces);
      const appliedMs=Math.round(performance.now()-start);
      const receipt=await evidence(workspace);
      for(const peer of workspaces.filter(item=>item.id!==workspace.id)){
        const audit=remote('audit',{workspace:peer.id});
        const expected=createHash('sha256').update(await readFile(join(peer.source,'revision.mjs'))).digest('hex');
        ensure(audit.sourceHash===expected,'A peer source projection was overwritten');
      }
      report.atomicUpdates.push({...receipt,appliedMs,feedbackMs:Math.round(performance.now()-start)});
    }
    const [a,b]=workspaces;
    report.agentGuard=remote('negative-agent',{workspace:a.id,other:b.id});
    ensure(report.agentGuard.rejected&&report.agentGuard.otherAlive,'Agent root guard failed');
    report.pidGuard=remote('negative-pid',{workspace:a.id,other:b.id});
    ensure(report.pidGuard.rejected===2&&report.pidGuard.otherAlive,'PID guard failed');
    const beforeStall=a.revision;
    remote('signal-agent',{workspace:a.id,signal:'SIGSTOP'});
    await atomicRevision(a,`${a.id}-queued-during-agent-stall`);
    const bStart=performance.now();await atomicRevision(b,`${b.id}-continues-during-agent-stall`);
    await wait(workspaces.slice(1));
    const stalled=request([a]).values[0];
    ensure(stalled.status===200&&stalled.body.revision===beforeStall,'A changed while its agent was stopped');
    report.stall={kind:'owned transport agent SIGSTOP/SIGCONT',peerUpdateMs:Math.round(performance.now()-bStart),oldRuntimeAvailable:true};
    remote('signal-agent',{workspace:a.id,signal:'SIGCONT'});
    const resumed=performance.now();await wait(workspaces);
    report.stall.recoveryMs=Math.round(performance.now()-resumed);report.stall.noMeasuredFlush=true;
    report.stall.receipt=await evidence(a);
    const beforeRestart=remote('agents');
    remote('signal-agent',{workspace:a.id,signal:'SIGKILL'});
    await atomicRevision(a,`${a.id}-queued-after-agent-restart`);
    const reconnect=performance.now();await wait(workspaces,60_000);
    const replacements=remote('agents').filter(item=>!beforeRestart.some(old=>old.pid===item.pid&&old.start===item.start));
    ensure(replacements.length===1,'Cannot uniquely attribute reconnected agent');
    await rememberAgent(a,replacements[0]);
    report.restart={kind:'owned transport agent SIGKILL/reconnect',recoveryMs:Math.round(performance.now()-reconnect),noMeasuredFlush:true,receipt:await evidence(a)};
    for(const workspace of workspaces){
      const failed=remote('failed-command',{workspace:workspace.id,revision:workspace.revision});
      ensure(failed.exit===1&&failed.redacted&&failed.text.includes('[redacted]')&&failed.text.includes(workspace.id),'Failed diagnostic was lost, unscoped or unredacted');
      report.feedback.push(failed);
    }
    report.offboarding={stop:remote('stop',{workspace:a.id})};stopped.add(a.id);
    const aSession=sessions.find(s=>s.workspace===a.id);
    mutagen(['sync','terminate',aSession.name]);aSession.live=false;
    report.offboarding.remove=remote('remove-workspace',{workspace:a.id});
    const peerStart=performance.now();
    for(const peer of workspaces.slice(1))await atomicRevision(peer,`${peer.id}-continues-after-A-cleanup`);
    await wait(workspaces.slice(1));
    report.offboarding.peers=await Promise.all(workspaces.slice(1).map(evidence));
    report.offboarding.peerUpdateMs=Math.round(performance.now()-peerStart);
    report.passed=true;
  } catch(error) {
    report.passed=false;report.failures.push(String(error.message).slice(0,4000));
  } finally {
    if(initialized){
      // A stopped endpoint must be resumed before terminating its session.
      for(const session of sessions)if(session.live){
        try {remote('signal-agent',{workspace:session.workspace,signal:'SIGCONT'});}
        catch(error){
          if(error.code==='ENOENT'||error.message==='Process ownership mismatch')report.cleanup.alreadyGoneEndpoints=(report.cleanup.alreadyGoneEndpoints??0)+1;
          else report.failures.push('Endpoint resume: '+String(error.message).slice(0,1000));
        }
      }
      for(const workspace of local?.worktrees??[])if(started.has(workspace.id)&&!stopped.has(workspace.id)){
        try {remote('stop',{workspace:workspace.id});}catch(error){report.failures.push('Watcher cleanup: '+String(error.message).slice(0,1000));}
      }
    }
    if(local&&daemonTouched){
      for(const session of sessions)if(session.live){
        try {mutagen(['sync','terminate',session.name]);session.live=false;}catch(error){report.failures.push('Session cleanup: '+String(error.message).slice(0,1000));}
      }
      try {command(config.mutagen,['daemon','stop'],{env:local.env,timeoutMs:15_000});report.cleanup.privateDaemonStopped=true;}
      catch(error){report.failures.push('Daemon cleanup: '+String(error.message).slice(0,1000));}
    }
    if(initialized){
      try {
        for(let n=0;n<40;n++){
          const gone=remote('verify-gone',{records:[...watchers,...agentsSeen]});
          if(gone.gone){report.cleanup.ownedProcessesGone=true;break;}
          await sleep(100);
        }
        ensure(report.cleanup.ownedProcessesGone,'An owned process remains after teardown');
        report.cleanup.remote=remote('cleanup',{workspaces:local.worktrees.map(w=>w.id)});
      }catch(error){report.failures.push('Remote cleanup: '+String(error.message).slice(0,1000));}
    }
    if(local){try{report.cleanup.local=await cleanupLocal(local);ensure(report.cleanup.local.removed,'Local worktree cleanup failed');}catch(error){report.failures.push('Local cleanup: '+String(error.message).slice(0,1000));}}
    process.off('SIGINT',signal);process.off('SIGTERM',signal);
    if(interrupted&&!report.failures.includes('Qualification interrupted'))report.failures.push('Qualification interrupted');
    report.interrupted=interrupted;report.finishedAt=new Date().toISOString();report.passed=report.passed===true&&report.failures.length===0;
  }
  await saveReport(config.report,report);
  return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    const config=options(process.argv.slice(2));
    if(config.help)console.log('Usage: node scripts/devstack-qualification/run.mjs --mutagen <absolute-binary> --container <existing-owned-container> --owner-label <key=value> --target-root <absolute-private-test-base> --tsx <target-absolute-tsx-cli> --report <new-absolute-json-path> [--count 3..8] [--user node]\nRequires the local orbstack context and a running, explicitly owned non-root Node 24+ target. Creates only synthetic worktree fixtures; agent stall/restart is not WAN or full Matrix parity qualification.');
    else {
      const report=await qualify(config);
      console.log(JSON.stringify({passed:report.passed,worktrees:report.worktreeCount,atomicUpdates:report.atomicUpdates.length,cleanup:report.cleanup,report:config.report}));
      process.exitCode=report.passed?0:1;
    }
  }catch(error){console.error('DevStack qualification failed: '+String(error.message).slice(0,4000));process.exitCode=1;}
}
