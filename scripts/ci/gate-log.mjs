// Gate check titles stay generic on the public PR, and the controller log is public too: never
// print raw exception text. Plain static helper messages (letters, digits, simple punctuation)
// are printed verbatim; anything that could carry a URL, host, path or upstream body is reduced
// to the error kind and HTTP status.
const PLAIN=/^[A-Za-z0-9 ,'()_-]{1,160}$/;
export function gateErrorLine(error){
 if(!(error instanceof Error))return 'unexpected non-Error value';
 const line=String(error.message).split('\n')[0];
 if(PLAIN.test(line))return line;
 const status=Number.isSafeInteger(error.status)?` (status ${error.status})`:'';
 return `unexpected ${PLAIN.test(error.name)?error.name:'Error'}${status}`;
}
