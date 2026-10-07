import { z } from 'zod/v4';
import { JevEmailTriageScoresSchema } from '@matrix-os/contracts';
import type { ArchivedMessage } from './types.js';
import { newsletterPolicy } from './policy.js';
import { MailRequestError } from './routes.js';
export function messageCategory(message:ArchivedMessage):'newsletter'|'review'|'other'{
 if(message.correction)return message.correction==='newsletter'?'newsletter':'other';
 if(!message.object||!message.classification)return 'review';
 const c=message.classification;
 const scores=JevEmailTriageScoresSchema.parse(Object.fromEntries(c.result.answers.map(answer=>[answer.id,answer.probability])));
 const category=newsletterPolicy(scores,c.contextKind==='verified').category;
 return category==='excluded'?'other':category;
}
/** Reader returns inert text only. No remote images, styles, links or HTML execution. */
export function readingText(value:{text?:unknown;html?:unknown}):string{
 if(typeof value.text==='string'&&value.text.trim())return value.text.slice(0,2*1024*1024);
 if(typeof value.html!=='string')return '';
 return value.html.slice(0,2*1024*1024).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<!--[\s\S]*?-->/g,'').replace(/<\/(p|div|h[1-6]|li)>|<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_all,name:string)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[name]??'')).trim();
}
const Cursor=z.strictObject({date:z.iso.datetime(),id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)});
export const mailCursor={encode:(value:z.infer<typeof Cursor>)=>Buffer.from(JSON.stringify(Cursor.parse(value))).toString('base64url'),decode(value:string){try{return Cursor.parse(JSON.parse(Buffer.from(value,'base64url').toString('utf8')));}catch(error){if(error instanceof SyntaxError||error instanceof z.ZodError)throw new MailRequestError(400);throw error;}}};
