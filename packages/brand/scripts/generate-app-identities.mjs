import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
export function renderAppIdentities(identities) {
 const entries=Object.entries(identities);
 for(const [id,value] of entries) {
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw Error('Invalid app identity');
  for(const key of ['accent','darkAccent','wash','glow']) if(!/^#[a-f0-9]{6}$/i.test(value[key])) throw Error('Invalid identity color');
 }
 const selectors=id=>`.workbench[data-app="${id}"], .app-identity[data-app="${id}"], :root:root:root[data-app="${id}"]`;
 return '/* Generated from @matrix-os/brand app-identities.json. Update the palette source, then regenerate. */\n'+
  entries.map(([id,p])=>`${selectors(id)} { --identity-accent:${p.accent}; --identity-wash:${p.wash}; --identity-glow:${p.glow}; --identity-on-accent:#ffffff; }`).join('\n')+
  '\n@media (prefers-color-scheme: dark) {\n'+entries.map(([id,p])=>` ${selectors(id)} { --identity-accent:${p.darkAccent}; --identity-on-accent:#202338; }`).join('\n')+'\n}\n';
}
async function generate(args) {
 const flags=['--connected-source','--default-source','--preview-source','--site-source'];
 if(args.length%2 || args.some((value,index)=> index%2===0 ? !flags.includes(value) : !isAbsolute(value))) throw Error('Pass explicit absolute repository roots');
 const roots=Object.fromEntries(Array.from({length:args.length/2},(_,i)=>[args[i*2],args[i*2+1]]));
 const identities=JSON.parse(await readFile(new URL('../src/app-identities.json',import.meta.url),'utf8'));
 const stylesheet=renderAppIdentities(identities);
 const destinations={
  '--connected-source':'home/app-templates/connected-starter/src/styles/app-identities.css',
  '--default-source':'home/apps/_shared/app-identities.css',
  '--preview-source':'specs/550-app-store-launch/design-prototype/src/AppIdentities.css',
  '--site-source':'src/app/apps/app-identities.css',
 };
 for(const [flag,root] of Object.entries(roots)) {
  await stat(resolve(root,'.git'));
  const target=resolve(root,destinations[flag]);
  await mkdir(dirname(target),{recursive:true}); await writeFile(target,stylesheet);
 }
 console.log(`Generated app identities for ${Object.keys(roots).length} repositories`);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await generate(process.argv.slice(2));
