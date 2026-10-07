/** Capped account queue and exponential retries; all state expires on revocation. */
export class MailSyncSchedule {
 private queued:string[]=[];
 private failures=new Map<string,{count:number;after:number}>();
 private previous:string|null=null;
 request(id:string){this.failures.delete(id);this.queued=this.queued.filter(value=>value!==id);this.queued.push(id);if(this.queued.length>100)this.queued.shift();}
 failed(id:string,now:number){const count=Math.min(7,(this.failures.get(id)?.count??0)+1);this.failures.delete(id);this.failures.set(id,{count,after:now+Math.min(3600000,60000*2**(count-1))});if(this.failures.size>100)this.failures.delete(this.failures.keys().next().value!);}
 succeeded(id:string){this.failures.delete(id);}
 pick(ids:readonly string[],now:number,liveIds:readonly string[]=ids):string|null{
  const valid=new Set(ids.slice(0,100));this.queued=this.queued.filter(id=>valid.has(id));const live=new Set(liveIds.slice(0,100));for(const id of this.failures.keys())if(!live.has(id))this.failures.delete(id);
  const requested=this.queued.shift();if(requested){this.previous=requested;return requested;}
  const offset=this.previous?ids.indexOf(this.previous)+1:0;
  for(let n=0;n<Math.min(ids.length,100);n++){const id=ids[(offset+n)%ids.length]!;if((this.failures.get(id)?.after??0)<=now){this.previous=id;return id;}}
  return null;
 }
 sizes(){return{queued:this.queued.length,failures:this.failures.size};}
}
