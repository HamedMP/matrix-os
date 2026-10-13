import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {gitRunner,reviewCarriesOver} from '../../scripts/review/review-carryover.mjs';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

function repo(){
 const root=mkdtempSync(join(tmpdir(),'review-carryover-'));roots.push(root);
 const git=gitRunner(root);
 const run=(...args:string[])=>git(args).trim();
 run('init','-q','-b','main');run('config','user.email','t@example.com');run('config','user.name','t');run('config','commit.gpgsign','false');
 const commit=(file:string,body:string,message:string)=>{writeFileSync(join(root,file),body);run('add',file);run('commit','-q','-m',message);return run('rev-parse','HEAD');};
 commit('app.ts','one\ntwo\nthree\nfour\nfive\n','base');
 run('checkout','-q','-b','feature');
 const reviewed=commit('app.ts','one\ntwo\nthree\nfour\nfive\nsix\n','feature');
 run('checkout','-q','main');
 commit('other.ts','main moved\n','main moves');
 commit('app.ts','zero\none\ntwo\nthree\nfour\nfive\n','main edits above the PR change');
 run('checkout','-q','feature');
 return {root,git,run,commit,reviewed};
}

it('carries the review over when the head only merges the base',()=>{
 const r=repo();r.run('merge','-q','--no-edit','main');
 expect(reviewCarriesOver(r.git,{reviewed:r.reviewed,head:r.run('rev-parse','HEAD'),baseRef:'main'})).toMatchObject({carry:true});
});

it('keeps the current head reviewed without inspecting history',()=>{
 const r=repo();
 expect(reviewCarriesOver(r.git,{reviewed:r.reviewed,head:r.reviewed,baseRef:'main'})).toEqual({carry:true,reason:'review names the current head'});
});

it('requires a fresh review when a PR commit follows the reviewed head',()=>{
 const r=repo();r.run('merge','-q','--no-edit','main');r.commit('app.ts','zero\none\ntwo\nthree\nfour\nfive\nsix\nseven\n','new work');
 expect(reviewCarriesOver(r.git,{reviewed:r.reviewed,head:r.run('rev-parse','HEAD'),baseRef:'main'})).toMatchObject({carry:false,reason:'PR-authored commits were added after the review'});
});

it('requires a fresh review when the base merge changes what the PR adds',()=>{
 const r=repo();r.run('merge','-q','--no-commit','main');
 writeFileSync(join(r.root,'app.ts'),'zero\none\ntwo\nthree\nfour\nfive\nSIX\n');r.run('add','app.ts');r.run('commit','-q','--no-edit');
 expect(reviewCarriesOver(r.git,{reviewed:r.reviewed,head:r.run('rev-parse','HEAD'),baseRef:'main'})).toMatchObject({carry:false,reason:'PR diff changed while integrating the base'});
});

it('requires a fresh review after history is rewritten',()=>{
 const r=repo();r.run('reset','-q','--hard','main');r.commit('app.ts','zero\none\ntwo\nthree\nfour\nfive\nsix\n','rebased feature');
 expect(reviewCarriesOver(r.git,{reviewed:r.reviewed,head:r.run('rev-parse','HEAD'),baseRef:'main'})).toMatchObject({carry:false,reason:'reviewed commit is not an ancestor of the head'});
});

it('fails closed when no reviewed commit is known',()=>{
 const r=repo();
 expect(reviewCarriesOver(r.git,{reviewed:'',head:r.reviewed,baseRef:'main'})).toMatchObject({carry:false});
});

it('exposes a CLI that only passes a 5/5 review that carries over',()=>{
 const source=execFileSync('node',['--check','scripts/review/review-carryover.mjs'],{encoding:'utf8'});
 expect(source).toBe('');
});
