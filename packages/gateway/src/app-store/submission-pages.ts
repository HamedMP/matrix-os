import { AppStoreCatalogQuerySchema } from '@matrix-os/contracts/app-store';

export interface SubmissionObservation { versionId: string; status: string }
interface SubmissionPage { submissions: readonly SubmissionObservation[]; nextCursor?: string }
const MAX_PAGES = 3;
const MAX_OBSERVATIONS = 500;
// Fixed enum, never grows.
const TERMINAL = new Set(['published', 'changes_requested', 'rejected', 'scan_failed', 'withdrawn', 'superseded']);
const cursor = (value: string) => AppStoreCatalogQuerySchema.shape.cursor.unwrap().parse(value);

/** Refresh newest submissions every time and advance a durable cursor through older history. */
export async function collectSubmissionPages(
  fetchPage: (cursor?: string) => Promise<SubmissionPage>, resume?: string,
): Promise<{ rows: SubmissionObservation[]; cursor?: string }> {
  // At most three pages of 100 entries. Prefer the head if moving pages overlap.
  const rows = new Map<string, SubmissionObservation>();
  const append = (page: SubmissionPage) => {
    if (page.submissions.length > 100) throw new Error('Submission page limit');
    for (const row of page.submissions) if (!rows.has(row.versionId)) rows.set(row.versionId, row);
  };
  const first = await fetchPage(undefined);
  append(first);
  // At most three cursor keys, discarded after this pass.
  const seen = new Set<string>();
  let next = resume ? cursor(resume) : first.nextCursor ? cursor(first.nextCursor) : undefined;
  for (let page = 1; next && page < MAX_PAGES; page++) {
    if (seen.has(next)) throw new Error('Repeated submission cursor');
    seen.add(next);
    let result: SubmissionPage;
    try { result = await fetchPage(next); }
    catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      console.warn('[app-store] Older submission page will retry', error.name);
      return { rows: [...rows.values()], cursor: next };
    }
    append(result);
    next = result.nextCursor ? cursor(result.nextCursor) : undefined;
    if (next && seen.has(next)) throw new Error('Repeated submission cursor');
  }
  return { rows: [...rows.values()], ...(next ? { cursor: next } : {}) };
}

/** Preserve every unfinished baseline before bounded, quiet historical terminal observations. */
export function retainSubmissionObservations(
  previous: Readonly<Record<string, string>>, rows: readonly SubmissionObservation[],
): Record<string, string> {
  if (Object.keys(previous).length > MAX_OBSERVATIONS || rows.length > 500) throw new Error('Submission observation limit');
  const entries = Object.entries({ ...previous, ...Object.fromEntries(rows.map(row => [row.versionId, row.status])) });
  const pending = entries.filter(([, status]) => !TERMINAL.has(status));
  if (pending.length > MAX_OBSERVATIONS) throw new Error('Unfinished submission limit');
  const remaining = MAX_OBSERVATIONS - pending.length;
  const terminal = remaining ? entries.filter(([, status]) => TERMINAL.has(status)).slice(-remaining) : [];
  return Object.fromEntries([...terminal, ...pending]);
}

/** An expired upload may have been deleted by the platform sweeper. Only an
 * exact owner-scoped lookup may retire that baseline; page omissions and time
 * alone cannot prove expiry. Reviews and published history are never evicted. */
export async function reconcileMissingSubmissionObservations(
 previous:Readonly<Record<string,string>>,rows:readonly SubmissionObservation[],
 lookup:(versionId:string)=>Promise<SubmissionObservation|null>,resume?:string,
):Promise<{rows:SubmissionObservation[];missing:string[];cursor?:string}>{
 if(Object.keys(previous).length>MAX_OBSERVATIONS||rows.length>MAX_OBSERVATIONS)throw new Error('Submission observation limit');
 const present=new Set(rows.map(row=>row.versionId)); // At most500, discarded each pass.
 const candidates=Object.keys(previous).filter(id=>['submitting','awaiting_upload'].includes(previous[id])&&!present.has(id)).sort();
 const start=resume?candidates.findIndex(id=>id>resume):0;
 const offset=start<0?0:start;const ordered=[...candidates.slice(offset),...candidates.slice(0,offset)];
 const result=[...rows],missing:string[]=[];let cursor:string|undefined;
 for(const id of ordered.slice(0,4)){
  cursor=id;
  try{const current=await lookup(id);if(current===null)missing.push(id);else{if(current.versionId!==id)throw new Error('Submission identity mismatch');result.push(current);}}
  catch(error:unknown){console.warn('[app-store] Upload observation lookup will retry',error instanceof Error?error.name:'UnknownError');}
 }
 return {rows:result,missing,...(cursor?{cursor}:{})};
}
