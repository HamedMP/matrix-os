import {redactSecrets,scanAppFiles} from '@matrix-os/contracts/app-store-scan';
import type {AppStoreGeneralizationReport} from '@matrix-os/contracts/app-store';
export function scrubSource(files:ReadonlyMap<string,Buffer>,ownerTerms:readonly string[]=[]):{files:Map<string,Buffer>;changes:AppStoreGeneralizationReport['changes']}{
 const output=new Map<string,Buffer>();const changes:AppStoreGeneralizationReport['changes']=[];
 const secretFiles=new Set(scanAppFiles(files,{ownerTerms:[...ownerTerms]}).findings.filter(f=>f.category==='secret').map(f=>f.file));
 for(const[path,bytes]of files){
  if(bytes.includes(0)){
   if(secretFiles.has(path)){changes.push({category:'secret',file:path,summary:'Removed binary containing a credential.'});continue;}
   output.set(path,Buffer.from(bytes));continue;
  }
  let text=redactSecrets(bytes.toString('utf8')).text;
  for(const term of ownerTerms.filter(value=>value.length>=3))text=text.split(term).join('Example');
  text=text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,'person@example.com');
  if(text!==bytes.toString('utf8'))changes.push({category:secretFiles.has(path)?'secret':'personal',file:path,summary:'Removed credentials or owner-specific details.'});
  output.set(path,Buffer.from(text));
 }
 return {files:output,changes:changes.slice(0,200)};
}
