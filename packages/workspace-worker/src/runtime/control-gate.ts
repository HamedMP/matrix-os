/** One bounded owner-local queue across native startup, checkpoint and destruction.
 * A native call draining late must finish before compute can be replaced.
 */
export class RuntimeControlGate {
  private tail:Promise<void>=Promise.resolve();
  private pending=0;
  async run(operation:()=>Promise<void>):Promise<void> {
    if(this.pending>=4) throw new Error('Runtime busy');
    this.pending++;
    const task=this.tail.then(operation);
    this.tail=task.then(()=>undefined,()=>undefined);
    try {await task;} finally {this.pending--;}
  }
}
