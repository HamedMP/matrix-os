// Gate check titles stay generic on the public PR, and the controller log is public too: never
// print raw exception text. Plain static helper messages (letters, digits, simple punctuation)
// are printed verbatim; anything that could carry a URL, host, path or upstream body (':', '.',
// control characters, long text) is reduced to the error kind and HTTP status.
const PLAIN=/^[A-Za-z0-9 ,'()_\-\/;]{1,160}$/;
export function gateErrorLine(error){
 if(!(error instanceof Error))return 'unexpected non-Error value';
 try{
  const line=String(error.message).split('\n')[0];
  if(PLAIN.test(line))return line;
  const name=typeof error.name==='string'&&PLAIN.test(error.name)?error.name:'Error';
  const status=Number.isSafeInteger(error.status)?` (status ${error.status})`:'';
  return `unexpected ${name}${status}`;
 }catch(formatError){
  // Formatting must never stop the caller's failure write, whatever a hostile getter throws;
  // the thrown value itself is never printed.
  void formatError;
  return 'unexpected unformattable error';
 }
}
// Shared line format for both gates; `event` names the gate and what happened.
export function logGateEvent(event,stage,error){console.warn(`${event} at ${stage}: ${gateErrorLine(error)}`);}
